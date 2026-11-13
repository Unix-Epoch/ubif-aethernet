package dev.aethernet.linkpearl.feature.alerts

import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The alerts routes of the phone API, typed. Paths are the full server paths (assumption: [ApiClient] only adds the host). */
class AlertsRemote(private val api: ApiClient) {
    companion object { const val BASE = "/v1/agents/m/alerts" }

    private inline fun <T> ApiResult<JsonElement>.parse(f: (JsonObject) -> T?): ApiResult<T> = when (this) {
        is ApiResult.Failure -> this
        is ApiResult.Success -> (value as? JsonObject)?.let(f)?.let { ApiResult.Success(it) } ?: ApiResult.Failure(ApiError.Server, message = "unreadable answer")
    }

    suspend fun feed(store: Int? = null, before: Int? = null, limit: Int = 25): ApiResult<FeedPage> {
        val q = buildMap {
            put("limit", limit.toString())
            put("store", store?.toString() ?: "all")
            if (before != null) put("before", before.toString())
        }
        return api.get(BASE, q).parse(::parseFeed)
    }

    /** The background poll. No [since] is the first run: the server answers the current cursor and no entries. */
    suspend fun poll(since: Int?): ApiResult<PollResult> =
        api.get("$BASE/new", if (since == null) emptyMap() else mapOf("since" to since.toString())).parse(::parsePoll)

    /** Returns the server's unread count. */
    suspend fun markRead(ids: List<Int>): ApiResult<Int> =
        api.post("$BASE/read", buildJsonObject { put("ids", JsonArray(ids.take(100).map { JsonPrimitive(it) })) }).parse { unreadOf(it) }

    suspend fun markAllRead(store: Int? = null): ApiResult<Int> =
        api.post("$BASE/read", buildJsonObject { put("all", true); if (store != null) put("store", store) }).parse { unreadOf(it) }

    private fun unreadOf(o: JsonObject): Int? = (o["unread"] as? JsonPrimitive)?.content?.toIntOrNull()

    suspend fun settings(): ApiResult<SettingsBundle> = api.get("$BASE/settings").parse(::parseSettings)

    suspend fun putSettings(patch: JsonObject): ApiResult<SettingsBundle> = api.put("$BASE/settings", patch).parse(::parseSettings)
}
