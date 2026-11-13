package dev.aethernet.linkpearl.feature.alerts

import dev.aethernet.linkpearl.core.design.Fmt
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import java.time.DateTimeException
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** The server's alert types (MOBILE-API-alerts.md). [Back] is feed-only and never notifies. */
enum class AlertType(val key: String, val label: String, val channelId: String?) {
    Stuck("stuck", "Stuck work orders", "alerts_stuck"),
    Pickup("pickup", "Waiting for pickup", "alerts_pickup"),
    Followup("followup", "Follow-up due", "alerts_followup"),
    Quiet("quiet", "Store gone quiet", "alerts_quiet"),
    Back("back", "Store back", null);

    /** The four types that have a switch and a threshold in settings. */
    val configurable: Boolean get() = this != Back

    companion object {
        val configurableTypes = listOf(Stuck, Pickup, Followup, Quiet)
        fun of(key: String?): AlertType? = entries.firstOrNull { it.key == key }
    }
}

/** One alert entry, feed or poll. Only the facts the contract names; there is never a customer or staff name. */
data class Alert(
    val id: Int,
    val store: Int,
    val type: AlertType,
    val wo: Long?,
    val at: String,
    val statusId: Int? = null,
    val status: String? = null,
    val days: Int? = null,
    val since: String? = null,
    val count: Int? = null,
    val oldestDays: Int? = null,
    val due: String? = null,
    val kind: String? = null,
    val hours: Int? = null,
    val resumedAt: String? = null,
    val read: Boolean = false,
    val notify: Boolean = false,
    val cleared: String? = null,
)

data class FeedPage(val cursor: Int, val unread: Int, val more: Boolean, val next: Int?, val now: String?, val alerts: List<Alert>)

data class PollResult(val cursor: Int, val alerts: List<Alert>, val held: Boolean, val more: Boolean)

// ---- JSON parsing (manual: unknown types are dropped, unknown fields ignored) ------------------------------------------------

private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
private fun JsonObject.int(k: String): Int? = (this[k] as? JsonPrimitive)?.intOrNull
private fun JsonObject.long(k: String): Long? = (this[k] as? JsonPrimitive)?.longOrNull
private fun JsonObject.bool(k: String): Boolean? = (this[k] as? JsonPrimitive)?.booleanOrNull

fun parseAlert(o: JsonObject): Alert? {
    val type = AlertType.of(o.str("type")) ?: return null
    return Alert(
        id = o.int("id") ?: return null, store = o.int("store") ?: return null, type = type, wo = o.long("wo"),
        at = o.str("at") ?: return null,
        statusId = o.int("statusId"), status = o.str("status"), days = o.int("days"), since = o.str("since"),
        count = o.int("count"), oldestDays = o.int("oldestDays"), due = o.str("due"), kind = o.str("kind"),
        hours = o.int("hours"), resumedAt = o.str("resumedAt"),
        read = o.bool("read") ?: false, notify = o.bool("notify") ?: false, cleared = o.str("cleared"),
    )
}

private fun alertsOf(a: Any?): List<Alert> = (a as? JsonArray)?.mapNotNull { (it as? JsonObject)?.let(::parseAlert) } ?: emptyList()

fun parseFeed(o: JsonObject): FeedPage? = FeedPage(
    cursor = o.int("cursor") ?: return null, unread = o.int("unread") ?: 0, more = o.bool("more") ?: false, next = o.int("next"),
    now = o.str("now"), alerts = alertsOf(o["alerts"]),
)

fun parsePoll(o: JsonObject): PollResult? = PollResult(
    cursor = o.int("cursor") ?: return null, alerts = alertsOf(o["alerts"]), held = o.bool("held") ?: false, more = o.bool("more") ?: false,
)

// ---- sentences ---------------------------------------------------------------------------------------------------------------

/** Store names come from the registered device's stores; a missing name falls back to "Store #id". */
object AlertText {
    /**
     * The store zone used for every time on the Alerts screens. [AlertsModule] keeps it at the zone Home reported (core/data
     * `StoreZone`); until then, and in tests, it is the zone the server uses today.
     */
    @Volatile var TZ: String = "America/New_York"

    fun storeName(id: Int, names: Map<Int, String>): String = names[id]?.takeIf { it.isNotBlank() } ?: "Store #$id"

    fun days(n: Int): String = Fmt.days(n)
    fun hours(n: Int): String = if (n == 1) "1 hour" else "$n hours"

    /** "9:00 AM" for a local hour of day. */
    fun hourOfDay(h: Int): String = LocalTime.of(h.coerceIn(0, 23), 0).format(DateTimeFormatter.ofPattern("h:mm a", Locale.US))

    /** "22:00" -> "10:00 PM"; unreadable input comes back unchanged. */
    fun clock24(hhmm: String): String = try { LocalTime.parse(hhmm).format(DateTimeFormatter.ofPattern("h:mm a", Locale.US)) } catch (_: DateTimeException) { hhmm }

    /** The sentence, composed on the phone exactly as the contract words it. */
    fun sentence(a: Alert, names: Map<Int, String>): String = when (a.type) {
        AlertType.Stuck -> "Work order ${a.wo ?: "—"} has been in ${a.status ?: "its status"} for ${days(a.days ?: 0)}"
        AlertType.Pickup -> {
            val n = a.count ?: 0
            (if (n == 1) "1 device has" else "$n devices have") + " waited at Ready for pickup for over ${days(a.days ?: 0)}"
        }
        AlertType.Followup -> "Follow-up due today on ${a.wo ?: "—"}"
        AlertType.Quiet -> "No updates from ${storeName(a.store, names)} since ${Fmt.clock(a.since, TZ)} (store hours)"
        AlertType.Back -> "Updates from ${storeName(a.store, names)} are back"
    }

    /** "Lynnhaven #326 · 3:40 PM" (the second line of every row). */
    fun meta(a: Alert, names: Map<Int, String>): String = Fmt.storeLabel(a.store, names[a.store]) + Fmt.DOT + Fmt.clock(a.at, TZ)

    /** "Today", "Yesterday" or "Wed, Nov 11" for [a]'s day, in the store zone, relative to [nowIso]. */
    fun dayHeading(atIso: String, nowIso: String, tz: String = TZ): String = try {
        val zone = ZoneId.of(tz)
        val day = Instant.parse(atIso).atZone(zone).toLocalDate()
        val today = Instant.parse(nowIso).atZone(zone).toLocalDate()
        when (day) {
            today -> "Today"
            today.minusDays(1) -> "Yesterday"
            else -> day.format(DateTimeFormatter.ofPattern("EEE, MMM d", Locale.US))
        }
    } catch (_: DateTimeException) { "" }

    /** "Fri, Nov 8 3:58 PM" in the store zone. */
    fun stamp(iso: String?): String = try {
        Instant.parse(iso).atZone(ZoneId.of(TZ)).format(DateTimeFormatter.ofPattern("EEE, MMM d h:mm a", Locale.US))
    } catch (_: Exception) { Fmt.DASH }

    /** The facts shown in the detail pane, label and value; nothing beyond what the contract carries. */
    fun facts(a: Alert, names: Map<Int, String>): List<Pair<String, String>> {
        val store = "Store" to Fmt.storeLabel(a.store, names[a.store])
        return when (a.type) {
            AlertType.Stuck -> listOf("Work order" to (a.wo?.toString() ?: Fmt.DASH), "Status" to (a.status ?: Fmt.DASH), "In status" to days(a.days ?: 0), "Since" to stamp(a.since), store)
            AlertType.Pickup -> listOf("Devices" to (a.count?.toString() ?: Fmt.DASH), "Oldest" to (a.oldestDays?.let { days(it) } ?: Fmt.DASH), "Longer than" to days(a.days ?: 0), store)
            AlertType.Followup -> listOf(
                "Work order" to (a.wo?.toString() ?: Fmt.DASH), "Due" to dueDate(a.due),
                "Kind" to when (a.kind) { "rfp" -> "Ready for pickup"; "callback" -> "Callback"; else -> Fmt.DASH }, store,
            )
            AlertType.Quiet -> listOf("Last update" to stamp(a.since), "Threshold" to hours(a.hours ?: 0), "Back" to (a.cleared?.let { stamp(it) } ?: "Not yet"), store)
            AlertType.Back -> listOf("Last update before" to stamp(a.since), "Resumed" to stamp(a.resumedAt), store)
        }
    }

    /** "Tue, Nov 10" for a `YYYY-MM-DD` due date. */
    fun dueDate(due: String?): String = try { LocalDate.parse(due).format(DateTimeFormatter.ofPattern("EEE, MMM d", Locale.US)) } catch (_: Exception) { Fmt.DASH }
}

/** One day's worth of alerts in the feed. */
data class DayGroup(val heading: String, val alerts: List<Alert>)

/** Feed order is newest first; groups keep it. */
fun groupByDay(alerts: List<Alert>, nowIso: String, tz: String = AlertText.TZ): List<DayGroup> {
    val out = ArrayList<DayGroup>()
    for (a in alerts) {
        val h = AlertText.dayHeading(a.at, nowIso, tz)
        if (out.isNotEmpty() && out.last().heading == h) out[out.lastIndex] = out.last().copy(alerts = out.last().alerts + a) else out += DayGroup(h, listOf(a))
    }
    return out
}
