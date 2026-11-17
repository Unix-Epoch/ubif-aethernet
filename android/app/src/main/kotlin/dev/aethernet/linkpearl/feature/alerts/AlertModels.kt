package dev.aethernet.linkpearl.feature.alerts

import dev.aethernet.linkpearl.core.design.Fmt
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import java.time.DateTimeException
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** The server's alert types (MOBILE-API-alerts.md). [Back] is feed-only and never notifies. [label] names the settings row. */
enum class AlertType(val key: String, val label: String, val channelId: String?, private val channel: String? = null) {
    Stuck("stuck", "Stuck work orders", "alerts_stuck"),
    Pickup("pickup", "Waiting for pickup", "alerts_pickup"),
    Followup("followup", "Follow-up due", "alerts_followup"),
    Quiet("quiet", "Store gone quiet", "alerts_quiet"),
    Back("back", "Store back", null),
    Digest("digest", "Morning digest", "alerts_digest"),
    Unlinked("unlinked", "Sales order unlinked", "alerts_unlinked", channel = "Sales orders"),
    Coverage("coverage", "Coverage check", "alerts_coverage");

    /** The types that have a switch in settings. */
    val configurable: Boolean get() = this != Back

    /** A switch plus one editable value (Coverage is a switch only). */
    val hasThreshold: Boolean get() = configurable && this != Coverage

    /** The Android notification channel's name. */
    val channelName: String get() = channel ?: label

    companion object {
        val configurableTypes = listOf(Stuck, Pickup, Followup, Quiet, Digest, Unlinked, Coverage)
        fun of(key: String?): AlertType? = entries.firstOrNull { it.key == key }
    }
}

/** A work order named by a digest: store, number, status name (null when not in the tracker), whole days in the status (stuck only). */
data class DigestWo(val store: Int, val wo: Long, val status: String?, val days: Int? = null)

/** The structured facts of a `digest` entry. Null numbers are "no data" (drawn as a dash, never 0). */
data class DigestFacts(
    val day: String? = null,
    val yesterday: String? = null,
    val stores: List<Int> = emptyList(),
    val sales: Double? = null,
    val splh: Double? = null,
    val hours: Double? = null,
    val target: List<Int>? = null,
    val rfpTotal: Double? = null,
    val rfpCount: Int? = null,
    val rfpOldestDays: Int? = null,
    val followupCount: Int? = null,
    val followups: List<DigestWo> = emptyList(),
    val stuckDays: Int? = null,
    val stuckCount: Int? = null,
    val stuck: List<DigestWo> = emptyList(),
) {
    /** The digest covers several stores: rows carry their store's label. */
    val manyStores: Boolean get() = stores.size > 1
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
    /** unlinked: oldest sales order's hours without a work order, and the numbers (oldest first). */
    val oldestHours: Int? = null,
    val salesOrders: List<String> = emptyList(),
    /** coverage */
    val checkedAt: String? = null,
    val countMisses: Int? = null,
    val countItems: Int? = null,
    val missedItems: Int? = null,
    val qtyMisses: Int? = null,
    val staleLabels: Int? = null,
    /** digest only. */
    val digest: DigestFacts? = null,
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
private fun JsonObject.dbl(k: String): Double? = (this[k] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
private fun JsonObject.obj(k: String): JsonObject? = this[k] as? JsonObject
private fun JsonObject.arr(k: String): JsonArray? = this[k] as? JsonArray

private fun digestWos(o: JsonObject?): List<DigestWo> = o?.arr("wos")?.mapNotNull { e ->
    val w = e as? JsonObject ?: return@mapNotNull null
    DigestWo(w.int("store") ?: return@mapNotNull null, w.long("wo") ?: return@mapNotNull null, w.str("status"), w.int("days"))
} ?: emptyList()

/** The digest facts; every part is optional (a missing part shows dashes, never zeros). */
fun parseDigest(o: JsonObject): DigestFacts {
    val rfp = o.obj("rfp"); val fu = o.obj("followups"); val st = o.obj("stuck")
    val target = o.arr("target")?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> !p.isString }?.doubleOrNull?.toInt() }?.takeIf { it.size == 2 }
    return DigestFacts(
        day = o.str("day"), yesterday = o.str("yesterday"),
        stores = o.arr("stores")?.mapNotNull { (it as? JsonPrimitive)?.intOrNull } ?: emptyList(),
        sales = o.dbl("sales"), splh = o.dbl("splh"), hours = o.dbl("hours"), target = target,
        rfpTotal = rfp?.dbl("total"), rfpCount = rfp?.int("count"), rfpOldestDays = rfp?.int("oldestDays"),
        followupCount = fu?.int("count"), followups = digestWos(fu),
        stuckDays = st?.int("days"), stuckCount = st?.int("count"), stuck = digestWos(st),
    )
}

fun parseAlert(o: JsonObject): Alert? {
    val type = AlertType.of(o.str("type")) ?: return null
    val digest = type == AlertType.Digest
    return Alert(
        id = o.int("id") ?: return null, store = o.int("store") ?: return null, type = type, wo = o.long("wo"),
        at = o.str("at") ?: return null,
        statusId = o.int("statusId"), status = o.str("status"), days = o.int("days"), since = o.str("since"),
        count = o.int("count"), oldestDays = o.int("oldestDays"), due = o.str("due"), kind = o.str("kind"),
        // A digest's "hours" is yesterday's labor hours (a decimal, inside [digest]), not a threshold.
        hours = if (digest) null else o.int("hours"), resumedAt = o.str("resumedAt"),
        oldestHours = o.int("oldestHours"),
        salesOrders = o.arr("salesOrders")?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.takeIf(String::isNotBlank) } ?: emptyList(),
        checkedAt = o.str("checkedAt"), countMisses = o.int("countMisses"), countItems = o.int("countItems"), missedItems = o.int("missedItems"),
        qtyMisses = o.int("qtyMisses"), staleLabels = o.int("staleLabels"),
        digest = if (digest) parseDigest(o) else null,
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
        AlertType.Digest -> "Morning digest"
        AlertType.Unlinked -> {
            val n = a.count ?: a.salesOrders.size
            when {
                n == 1 && a.salesOrders.size == 1 -> "Sales order ${a.salesOrders[0]} has no work order"
                n == 1 -> "1 sales order has no work order"
                else -> "$n sales orders have no work order"
            }
        }
        AlertType.Coverage -> {
            val parts = listOfNotNull(
                a.countMisses?.takeIf { it > 0 }?.let { "${items(it)} short of labels" },
                a.missedItems?.takeIf { it > 0 }?.let { "${items(it)} missed" },
            )
            if (parts.isEmpty()) "Coverage check" else "Coverage check: " + parts.joinToString(", ")
        }
    }

    private fun items(n: Int) = if (n == 1) "1 item" else "$n items"

    /** "Lynnhaven #326 · 3:40 PM" (the second line of every row); a digest over several stores is filed under "All stores". */
    fun meta(a: Alert, names: Map<Int, String>): String {
        val where = if (a.digest?.manyStores == true) "All stores" else Fmt.storeLabel(a.store, names[a.store])
        return where + Fmt.DOT + Fmt.clock(a.at, TZ)
    }

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
            AlertType.Digest -> listOf("Day" to dueDate(a.digest?.day), store)
            AlertType.Unlinked -> listOf(
                "Sales orders" to Fmt.count(a.count), "Oldest" to (a.oldestHours?.let { hours(it) } ?: Fmt.DASH),
                "Longer than" to (a.hours?.let { hours(it) } ?: Fmt.DASH), store,
            )
            AlertType.Coverage -> listOf(
                "Short of labels" to (a.countMisses?.let { m -> a.countItems?.let { "$m of $it" } ?: m.toString() } ?: Fmt.DASH),
                "Missed items" to Fmt.count(a.missedItems), "Quantity misses" to Fmt.count(a.qtyMisses), "Stale labels" to Fmt.count(a.staleLabels),
                "Checked" to stamp(a.checkedAt), store,
            )
        }
    }

    /** "Tue, Nov 10" for a `YYYY-MM-DD` due date. */
    fun dueDate(due: String?): String = try { LocalDate.parse(due).format(DateTimeFormatter.ofPattern("EEE, MMM d", Locale.US)) } catch (_: Exception) { Fmt.DASH }
}

/** The digest's words: the notification (title plus up to three lines, zero lines left out) and the screen's date. */
object DigestText {
    /** "Yesterday $2,096 · $168 per labor hour". */
    fun title(d: DigestFacts): String = "Yesterday ${Fmt.money(d.sales)}${Fmt.DOT}${Fmt.money(d.splh)} per labor hour"

    /** "RFP total $885 · 3 waiting", "2 follow-ups due today", "1 work order stuck"; a line whose count is zero (or unknown) is left out. */
    fun lines(d: DigestFacts): List<String> = listOfNotNull(
        d.rfpCount?.takeIf { it > 0 }?.let { "RFP total ${Fmt.money(d.rfpTotal)}${Fmt.DOT}$it waiting" },
        d.followupCount?.takeIf { it > 0 }?.let { if (it == 1) "1 follow-up due today" else "$it follow-ups due today" },
        d.stuckCount?.takeIf { it > 0 }?.let { if (it == 1) "1 work order stuck" else "$it work orders stuck" },
    )

    /** "Mon, Nov 16" for the digest's day. */
    fun date(d: DigestFacts): String = AlertText.dueDate(d.day)
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
