package dev.aethernet.linkpearl.feature.retrace

import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.feature.workorders.WoJson
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.JsonElement

/**
 * Retrace calls through [ApiClient] (`tracker-worker/MOBILE-API-retrace.md`): one store per request, plain data only, nothing cached.
 * A 404 from the tracker (a tracker that predates these routes, or an item or label it has not seen) is reported as a server failure so the
 * screens show their generic "Couldn't load" state.
 */
class RetraceRepository(private val api: ApiClient) {
    suspend fun items(store: Int, q: String?, after: String?, limit: Int = 25): ApiResult<RtItemsResponse> {
        val params = buildMap {
            put("store", store.toString()); put("limit", limit.toString())
            if (!q.isNullOrBlank()) put("q", q)
            if (after != null) put("after", after)
        }
        return decode(api.get("$BASE/items", params), RtItemsResponse.serializer())
    }

    suspend fun item(store: Int, item: String): ApiResult<RtItemResponse> =
        decode(api.get("$BASE/item/$store/${enc(item)}", emptyMap()), RtItemResponse.serializer())

    suspend fun label(store: Int, label: String): ApiResult<RtLabelResponse> =
        decode(api.get("$BASE/label/$store/${enc(label)}", emptyMap()), RtLabelResponse.serializer())

    suspend fun pos(store: Int, after: String?, limit: Int = 25): ApiResult<RtPosResponse> {
        val params = buildMap { put("store", store.toString()); put("limit", limit.toString()); if (after != null) put("after", after) }
        return decode(api.get("$BASE/pos", params), RtPosResponse.serializer())
    }

    private fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    private fun <T> decode(r: ApiResult<JsonElement>, s: DeserializationStrategy<T>): ApiResult<T> = when (r) {
        is ApiResult.Success -> try { ApiResult.Success(WoJson.decodeFromJsonElement(s, r.value)) } catch (_: Exception) { ApiResult.Failure(ApiError.Server, message = "bad answer") }
        is ApiResult.Failure -> if (r.error == ApiError.NotFound) ApiResult.Failure(ApiError.Server, r.status, r.message) else r
    }

    companion object {
        const val BASE = "/v1/agents/m/retrace"
    }
}
