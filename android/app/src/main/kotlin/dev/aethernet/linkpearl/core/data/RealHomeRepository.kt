package dev.aethernet.linkpearl.core.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.decodeFromJsonElement
import java.util.concurrent.ConcurrentHashMap

@Serializable
private data class CachedHome(val savedAtMs: Long, val data: HomeData)

/**
 * Home's numbers from `GET /v1/agents/m/home?store=<id>|all[&fresh=1]`. The last good answer per scope is kept in memory and, when a
 * [cache] file is given, encrypted on disk, so the app opens with numbers when the network is down (returned `cached = true`; the screen
 * dates them with the answer's own `asOf`). A `{empty:true}` answer (no approved stores) is returned as is and never cached.
 */
class RealHomeRepository(
    private val api: ApiClient,
    private val cache: EncryptedFile? = null,
    private val onStores: (List<StoreRef>) -> Unit = {},
    private val nowMs: () -> Long = System::currentTimeMillis,
) : HomeRepository {
    private val memory = ConcurrentHashMap<String, CachedHome>()
    private val mapSerializer = MapSerializer(String.serializer(), CachedHome.serializer())
    private var diskLoaded = false

    override suspend fun load(scope: StoreScope, fresh: Boolean): HomeResult {
        val query = buildMap { put("store", scope.key); if (fresh) put("fresh", "1") }
        return when (val r = api.get("/v1/agents/m/home", query)) {
            is ApiResult.Success -> {
                val data = try { LinkpearlJson.decodeFromJsonElement<HomeData>(r.value) } catch (_: Exception) { return HomeResult.Failed(FailureReason.Server) }
                if (!data.empty) remember(scope, data)
                onStores(data.stores)
                HomeResult.Ok(data, cached = false)
            }
            is ApiResult.Failure -> when (r.error) {
                ApiError.Offline -> cached(scope)?.let { HomeResult.Ok(it.data, cached = true) } ?: HomeResult.Failed(FailureReason.Offline)
                ApiError.Unauthorized -> HomeResult.Failed(FailureReason.Unauthorized)
                ApiError.Forbidden -> when (r.message) {
                    "not your store" -> HomeResult.Failed(FailureReason.NotYourStore)
                    OkHttpApiClient.NOT_APPROVED -> HomeResult.Failed(FailureReason.Unauthorized)
                    else -> HomeResult.Failed(FailureReason.Server)
                }
                else -> HomeResult.Failed(FailureReason.Server)
            }
        }
    }

    /** Forgets every saved answer (sign-out, revoked registration). */
    fun clear() {
        memory.clear()
        cache?.delete()
        diskLoaded = true
    }

    private suspend fun remember(scope: StoreScope, data: HomeData) {
        val entry = CachedHome(nowMs(), data)
        memory[scope.key] = entry
        if (cache != null) withContext(Dispatchers.IO) {
            runCatching { synchronized(this@RealHomeRepository) { cache.write(LinkpearlJson.encodeToString(mapSerializer, memory.toMap()).toByteArray()) } }
        }
    }

    private suspend fun cached(scope: StoreScope): CachedHome? {
        memory[scope.key]?.let { return it }
        if (cache != null && !diskLoaded) withContext(Dispatchers.IO) {
            synchronized(this@RealHomeRepository) {
                if (!diskLoaded) {
                    runCatching { cache.read()?.let { memory.putAll(LinkpearlJson.decodeFromString(mapSerializer, it.decodeToString())) } }
                    diskLoaded = true
                }
            }
        }
        return memory[scope.key]
    }
}
