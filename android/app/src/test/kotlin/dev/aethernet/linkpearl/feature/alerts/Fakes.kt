package dev.aethernet.linkpearl.feature.alerts

import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** The JSON from MOBILE-API-alerts.md, verbatim where the contract gives a full object. */
object Contract {
    private fun j(s: String): JsonObject = Json.parseToJsonElement(s) as JsonObject

    /** Feed example from the contract (GET /alerts). */
    val feed = j("""
        { "v": 1, "now": "2026-10-15T20:05:00.000Z", "cursor": 412, "unread": 2, "more": true, "next": 398,
          "alerts": [
            { "id": 412, "store": 914, "type": "stuck", "wo": 401, "at": "2026-10-15T15:00:00.000Z", "statusId": 9, "status": "Diagnostics", "days": 3,
              "since": "2026-10-12T14:54:59.000Z", "read": false, "notify": true },
            { "id": 411, "store": 326, "type": "quiet", "wo": null, "at": "2026-10-15T19:41:00.000Z", "since": "2026-10-15T17:40:00.000Z", "hours": 2,
              "read": true, "notify": false, "cleared": "2026-10-15T22:40:00.000Z" }
          ] }
    """.trimIndent())

    /** Poll example from the contract (GET /alerts/new?since=398). */
    val poll = j("""
        { "v": 1, "cursor": 412, "alerts": [ { "id": 411, "store": 326, "type": "quiet", "wo": null, "at": "2026-10-15T19:41:00.000Z", "since": "2026-10-15T17:40:00.000Z", "hours": 2 },
                                              { "id": 412, "store": 914, "type": "stuck", "wo": 401, "at": "2026-10-15T15:00:00.000Z", "statusId": 9, "status": "Diagnostics", "days": 3, "since": "2026-10-12T14:54:59.000Z" } ] }
    """.trimIndent())

    val firstRun = j("""{ "v": 1, "cursor": 412, "alerts": [] }""")
    val held = j("""{ "v": 1, "cursor": 398, "alerts": [], "held": true }""")

    /** Settings example from the contract (GET /alerts/settings). */
    val settings = j("""
        { "v": 1,
          "settings": { "types": { "stuck": { "on": true, "days": 3 }, "pickup": { "on": true, "days": 7 }, "followup": { "on": true, "hour": 9 }, "quiet": { "on": true, "hours": 2 } },
                        "quietHours": { "on": true, "from": "22:00", "to": "07:00" },
                        "stores": { "914": true, "326": true } },
          "stores": [914, 326],
          "ranges": { "stuckDays": [1, 30], "pickupDays": [1, 30], "quietHours": [1, 12], "followupHour": [0, 23] } }
    """.trimIndent())

    /** The entry head from "Alert entry" with the stuck facts of the sentence table (work order 700000014, Repair summary, 5 days). */
    val stuck700000014 = j("""{ "id": 413, "store": 914, "type": "stuck", "wo": 700000014, "at": "2026-10-15T15:05:00.000Z", "statusId": 9, "status": "Repair summary", "days": 5, "since": "2026-10-10T15:05:00.000Z" }""")

    // The fact table gives fields but no complete example object for these three; built from it, field for field.
    val pickup = j("""{ "id": 414, "store": 914, "type": "pickup", "wo": null, "at": "2026-10-15T13:00:00.000Z", "count": 3, "days": 7, "oldestDays": 11 }""")
    val followup = j("""{ "id": 415, "store": 914, "type": "followup", "wo": 700000003, "at": "2026-10-15T13:00:00.000Z", "due": "2026-10-15", "kind": "rfp" }""")
    val back = j("""{ "id": 416, "store": 326, "type": "back", "wo": null, "at": "2026-10-15T22:40:00.000Z", "since": "2026-10-15T17:40:00.000Z", "resumedAt": "2026-10-15T22:40:00.000Z" }""")
}

fun alertOf(o: JsonObject): Alert = parseAlert(o)!!

/** A scripted server: [handler] sees every call (method, path, query, body) and answers. */
class FakeApi(var handler: (String, String, Map<String, String>, JsonElement?) -> ApiResult<JsonElement>) : ApiClient {
    val calls = mutableListOf<List<Any?>>()
    private fun call(m: String, p: String, q: Map<String, String>, b: JsonElement?): ApiResult<JsonElement> {
        calls += listOf(m, p, q, b)
        return handler(m, p, q, b)
    }
    override suspend fun get(path: String, query: Map<String, String>) = call("GET", path, query, null)
    override suspend fun post(path: String, body: JsonElement?) = call("POST", path, emptyMap(), body)
    override suspend fun put(path: String, body: JsonElement?) = call("PUT", path, emptyMap(), body)
    override suspend fun delete(path: String) = call("DELETE", path, emptyMap(), null)
    fun count(method: String, pathEnd: String) = calls.count { it[0] == method && (it[1] as String).endsWith(pathEnd) }
}

fun ok(o: JsonElement): ApiResult<JsonElement> = ApiResult.Success(o)
fun fail(e: ApiError): ApiResult<JsonElement> = ApiResult.Failure(e)

class MemoryCheckState(var cursorValue: Int? = null) : CheckState {
    var last: Long? = null
    var unreadValue: Int? = null
    var asks = 0
    override suspend fun cursor() = cursorValue
    override suspend fun setCursor(v: Int) { cursorValue = v }
    override suspend fun lastCheck() = last
    override suspend fun setLastCheck(ms: Long) { last = ms }
    override suspend fun unread() = unreadValue
    override suspend fun setUnread(v: Int) { unreadValue = v }
    override suspend fun permissionAsks() = asks
    override suspend fun setPermissionAsks(v: Int) { asks = v }
    override suspend fun clear() { cursorValue = null; last = null; unreadValue = null }
}

class FakeNotifier(var allowed: Boolean = true, var postWorks: Boolean = true) : AlertNotifier {
    val posted = mutableListOf<PlannedNote>()
    val cancelled = mutableListOf<Int>()
    override fun canNotify() = allowed
    override fun post(notes: List<PlannedNote>): Boolean { if (!postWorks) return false; posted += notes; return true }
    override fun cancel(alertIds: List<Int>) { cancelled += alertIds }
}
