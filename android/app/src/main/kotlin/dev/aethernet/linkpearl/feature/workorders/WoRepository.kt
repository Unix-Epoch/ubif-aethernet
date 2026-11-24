package dev.aethernet.linkpearl.feature.workorders

import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.data.decode
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

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
                LaneFilter.All, LaneFilter.Old -> put("state", "open")
                is LaneFilter.One -> { put("state", "open"); put("lane", f.lane.key) }
                LaneFilter.FollowUps -> { put("state", "open"); put("followups", "1") }
                LaneFilter.Closed -> put("state", "closed")
                LaneFilter.Recent -> { put("state", "recent"); put("closedDays", "7") }
            }
            put("sort", if (q.filter == LaneFilter.Closed || q.filter == LaneFilter.Recent) WoSort.Closed.key else q.sort.key)
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

    /**
     * Every open work order of [store] (null = all) that is old by [WoAging], oldest first: pages the open list longest-in-status first
     * and stops at the first page whose last row is younger than the shortest limit (no later row can be old), or after [maxPages].
     */
    suspend fun oldRows(store: Int?, cards: Boolean, nowMs: Long, maxPages: Int = 10): ApiResult<List<WoRow>> {
        val out = mutableListOf<WoRow>()
        var after: String? = null
        var pages = 0
        do {
            val r = list(ListQuery(store, LaneFilter.All, WoSort.Status, cards = cards, after = after, limit = 100))
            if (r !is ApiResult.Success) return r as ApiResult.Failure
            out += r.value.rows.filter { WoAging.isOld(it, nowMs) }
            after = r.value.next
            pages++
            val last = r.value.rows.lastOrNull()?.let { WoAging.minutes(it, nowMs) }
            if (last == null || last < WoAging.MIN_DAYS * 1440.0) break
        } while (after != null && pages < maxPages)
        return ApiResult.Success(out)
    }

    // ---- Waymark from the phone (MOBILE-API-waymark.md) ------------------------------------------------------------------------

    private val _changed = MutableSharedFlow<WoRow>(extraBufferCapacity = 8)
    /** A work order this phone just changed (tags or follow-up), so the list can update its row. */
    val changed: SharedFlow<WoRow> = _changed.asSharedFlow()
    fun notifyChanged(row: WoRow) { _changed.tryEmit(row) }

    suspend fun waymarkTags(store: Int): ApiResult<WaymarkTagsResponse> =
        decode(api.get("$WAYMARK/tags", mapOf("store" to store.toString())), WaymarkTagsResponse.serializer())

    suspend fun setTag(key: WoKey, tag: String, on: Boolean): ApiResult<WaymarkTagResponse> =
        decode(api.post("$WAYMARK/tag", buildJsonObject { put("store", key.store); put("wo", key.wo); put("tag", tag); put("on", on) }), WaymarkTagResponse.serializer())

    /** Moves the follow-up to [due] ("YYYY-MM-DD", later than the current one). */
    suspend fun pushFollowUp(key: WoKey, due: String): ApiResult<WaymarkFollowUpResponse> =
        decode(api.post("$WAYMARK/followup", buildJsonObject { put("store", key.store); put("wo", key.wo); put("due", due) }), WaymarkFollowUpResponse.serializer())

    suspend fun removeFollowUp(key: WoKey): ApiResult<WaymarkFollowUpResponse> =
        decode(api.post("$WAYMARK/followup", buildJsonObject { put("store", key.store); put("wo", key.wo); put("remove", true) }), WaymarkFollowUpResponse.serializer())

    // ---- the in-memory "last good list" (plain rows only) --------------------------------------------------------------------

    fun remember(q: ListQuery, page: WoListResponse, atMs: Long) = synchronized(lastPages) {
        lastPages[cacheKey(q)] = page.copy(rows = page.rows.map { it.copy(card = null) }, cards = false) to atMs
        while (lastPages.size > 12) lastPages.remove(lastPages.keys.first())
    }

    fun lastGood(q: ListQuery): Pair<WoListResponse, Long>? = synchronized(lastPages) { lastPages[cacheKey(q)] }

    private fun cacheKey(q: ListQuery) = "${q.store}|${q.filter}|${q.sort}"

    private fun <T> decode(r: ApiResult<JsonElement>, s: DeserializationStrategy<T>): ApiResult<T> = r.decode(s, WoJson)

    companion object {
        const val BASE = "/v1/agents/m/wo"
        const val WAYMARK = "/v1/agents/m/waymark"
    }
}
