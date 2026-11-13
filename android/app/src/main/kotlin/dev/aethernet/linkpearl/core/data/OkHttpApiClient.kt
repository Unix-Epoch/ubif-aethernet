package dev.aethernet.linkpearl.core.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.Call
import okhttp3.Callback
import okhttp3.ConnectionSpec
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/** Told when the server stops accepting this phone's token (401) or says it is not approved yet (403): [Auth] re-checks /me. */
fun interface SessionHooks { fun sessionRejected() }

/** What [RealAuth] needs beyond [ApiClient]: a call with explicit credentials (registration has none yet; /me must not loop into the hook). */
interface AgentTransport {
    suspend fun call(method: String, path: String, query: Map<String, String> = emptyMap(), body: JsonElement? = null, credentials: Credentials?, notify: Boolean): ApiResult<JsonElement>
}

/**
 * [ApiClient] over OkHttp. HTTPS only (plain http is accepted for loopback hosts only when [allowLoopbackHttp], i.e. tests), redirects are
 * not followed, bodies are capped at [maxBytes], idempotent GETs get one retry on a network error. Never logs; nothing here prints headers.
 */
class OkHttpApiClient(
    baseUrl: String,
    private val appKey: String,
    private val credentials: () -> Credentials?,
    private val hooks: () -> SessionHooks? = { null },
    client: OkHttpClient = defaultHttpClient(),
    private val maxBytes: Long = 4L * 1024 * 1024,
    allowLoopbackHttp: Boolean = false,
    private val userAgent: String = "Linkpearl",
) : ApiClient, AgentTransport {
    private val base: HttpUrl = baseUrl.toHttpUrl().also {
        require(it.isHttps || (allowLoopbackHttp && it.host in LOOPBACK)) { "the server URL must be https" }
    }
    private val http = client.newBuilder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build() // retries are ours: one, GET only

    override suspend fun get(path: String, query: Map<String, String>) = call("GET", path, query, null, credentials(), true)
    override suspend fun post(path: String, body: JsonElement?) = call("POST", path, emptyMap(), body ?: EmptyObject, credentials(), true)
    override suspend fun put(path: String, body: JsonElement?) = call("PUT", path, emptyMap(), body ?: EmptyObject, credentials(), true)
    override suspend fun delete(path: String) = call("DELETE", path, emptyMap(), null, credentials(), true)

    override suspend fun call(method: String, path: String, query: Map<String, String>, body: JsonElement?, credentials: Credentials?, notify: Boolean): ApiResult<JsonElement> {
        val url = try {
            base.newBuilder().apply {
                path.substringBefore('?').trim('/').split('/').filter { it.isNotEmpty() }.forEach { addPathSegment(it) }
                query.forEach { (k, v) -> addQueryParameter(k, v) }
            }.build()
        } catch (_: Exception) {
            return ApiResult.Failure(ApiError.NotConfigured)
        }
        val request = Request.Builder().url(url)
            .header("x-aethernet-key", appKey).header("accept", "application/json").header("user-agent", userAgent)
            .apply { if (credentials != null) header("authorization", credentials.bearer) }
            .method(method, body?.let { LinkpearlJson.encodeToString(JsonElement.serializer(), it).toRequestBody(JSON) })
            .build()
        val attempts = if (method == "GET") 2 else 1
        var result: ApiResult<JsonElement> = ApiResult.Failure(ApiError.Offline)
        for (i in 1..attempts) {
            result = execute(request)
            if (!(result is ApiResult.Failure && result.error == ApiError.Offline)) break
        }
        if (notify && result is ApiResult.Failure) {
            val rejected = result.error == ApiError.Unauthorized || (result.error == ApiError.Forbidden && result.message == NOT_APPROVED)
            if (rejected) hooks()?.sessionRejected()
        }
        return result
    }

    private suspend fun execute(request: Request): ApiResult<JsonElement> {
        val response = try {
            http.newCall(request).await()
        } catch (e: CancellationException) {
            throw e
        } catch (_: IOException) {
            return ApiResult.Failure(ApiError.Offline)
        } catch (_: Exception) {
            return ApiResult.Failure(ApiError.Server)
        }
        return response.use { r ->
            val read = try { readCapped(r) } catch (_: IOException) { return@use ApiResult.Failure(ApiError.Offline, r.code) }
            val text = read ?: return@use ApiResult.Failure(ApiError.Server, r.code, "answer too large")
            val json = runCatching { LinkpearlJson.parseToJsonElement(text.ifBlank { "{}" }) }.getOrNull()
            if (r.isSuccessful) {
                if (json !is JsonObject && json !is kotlinx.serialization.json.JsonArray) ApiResult.Failure(ApiError.Server, r.code, "bad answer") else ApiResult.Success(json)
            } else {
                val message = ((json as? JsonObject)?.get("error") as? JsonPrimitive)?.contentOrNull?.take(200)
                ApiResult.Failure(errorFor(r.code), r.code, message)
            }
        }
    }

    /** The body as text, or null when it is longer than [maxBytes]. */
    private fun readCapped(r: Response): String? {
        val source = r.body.source()
        if (source.request(maxBytes + 1)) return null
        return source.buffer.readUtf8()
    }

    companion object {
        const val NOT_APPROVED = "not approved yet"
        private val JSON = "application/json".toMediaType()
        private val LOOPBACK = setOf("localhost", "127.0.0.1", "[::1]", "::1")

        fun errorFor(status: Int): ApiError = when {
            status == 401 -> ApiError.Unauthorized
            status == 403 -> ApiError.Forbidden
            status == 404 -> ApiError.NotFound
            status == 429 -> ApiError.RateLimited
            else -> ApiError.Server
        }

        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).writeTimeout(20, TimeUnit.SECONDS).callTimeout(30, TimeUnit.SECONDS)
            .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS, ConnectionSpec.CLEARTEXT)) // cleartext is only reachable through the loopback allowance above
            .build()
    }
}

private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) { if (cont.isActive) cont.resumeWith(Result.failure(e)) }
        override fun onResponse(call: Call, response: Response) { if (cont.isActive) cont.resume(response) else response.close() }
    })
    cont.invokeOnCancellation { cancel() }
}
