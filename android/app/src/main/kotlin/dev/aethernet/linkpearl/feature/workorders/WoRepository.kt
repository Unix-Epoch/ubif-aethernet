package dev.aethernet.linkpearl.feature.workorders

import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.JsonElement

/** The parameters of one list page. [store] null = all of the phone's stores. */
data class ListQuery(
    val store: Int?,
    val filter: LaneFilter,
    val sort: WoSort,
    val cards: Boolean = false,
    val after: String? = null,
    val limit: Int = 25,
)

/**
 * Work order calls through [ApiClient]. Also keeps the last successful plain first page per query IN MEMORY (with the sealed cards
 * stripped) so the list can be shown offline while the process lives; nothing is written to disk.
 */
class WoRepository(private val api: ApiClient) {
    private val lastPages = LinkedHashMap<String, Pair<WoListResponse, Long>>()

    suspend fun list(q: ListQuery): ApiResult<WoListResponse> {
        val params = buildMap {
            put("store", q.store?.toString() ?: "all")
            when (val f = q.filter) {
                LaneFilter.All -> put("state", "open")
                is LaneFilter.One -> { put("state", "open"); put("lane", f.lane.key) }
                LaneFilter.Closed -> { put("state", "recent"); put("closedDays", "7") }
            }
            put("sort", if (q.filter == LaneFilter.Closed) WoSort.Closed.key else q.sort.key)
            put("limit", q.limit.toString())
            if (q.after != null) put("after", q.after)
            if (q.cards) put("cards", "1")
        }
        return decode(api.get(BASE, params), WoListResponse.serializer())
    }

    suspend fun find(digits: String, store: Int? = null, limit: Int = 20): ApiResult<WoFindResponse> {
        val params = buildMap { put("q", digits); put("limit", limit.toString()); if (store != null) put("store", store.toString()) }
        return decode(api.get("$BASE/find", params), WoFindResponse.serializer())
    }

    suspend fun detail(key: WoKey, sealed: Boolean): ApiResult<WoDetailResponse> =
        decode(api.get("$BASE/${key.store}/${key.wo}", if (sealed) mapOf("sealed" to "1") else emptyMap()), WoDetailResponse.serializer())

    // ---- the in-memory "last good list" (plain rows only) --------------------------------------------------------------------

    fun remember(q: ListQuery, page: WoListResponse, atMs: Long) = synchronized(lastPages) {
        lastPages[cacheKey(q)] = page.copy(rows = page.rows.map { it.copy(card = null) }, cards = false) to atMs
        while (lastPages.size > 12) lastPages.remove(lastPages.keys.first())
    }

    fun lastGood(q: ListQuery): Pair<WoListResponse, Long>? = synchronized(lastPages) { lastPages[cacheKey(q)] }

    private fun cacheKey(q: ListQuery) = "${q.store}|${q.filter}|${q.sort}"

    private fun <T> decode(r: ApiResult<JsonElement>, s: DeserializationStrategy<T>): ApiResult<T> = when (r) {
        is ApiResult.Success -> try { ApiResult.Success(WoJson.decodeFromJsonElement(s, r.value)) } catch (_: Exception) { ApiResult.Failure(ApiError.Server, message = "bad answer") }
        is ApiResult.Failure -> r
    }

    companion object {
        const val BASE = "/v1/agents/m/wo"
    }
}
