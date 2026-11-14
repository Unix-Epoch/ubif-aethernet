package dev.aethernet.linkpearl.feature.workorders

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The plain (unsealed) work order shapes of `GET /v1/agents/m/wo…` (tracker-worker/MOBILE-API-wo.md). Every field is optional so a
 * missing or new field never breaks decoding. No customer data is in any of these; the sealed `card` is an opaque string.
 */
internal val WoJson: Json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true; isLenient = true }

@Serializable
data class WoRow(
    val store: Int = 0,
    val wo: Long = 0,
    val open: Boolean = true,
    val statusId: Int? = null,
    val status: String? = null,
    val lane: String? = null,
    val device: String? = null,
    val program: String? = null,
    val bin: String? = null,
    val outcome: String? = null,
    val cartValue: Double? = null,
    val cartDue: Double? = null,
    val statusSince: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val closedAt: String? = null,
    val notes: Int? = null,
    /** Sealed search card ("v1.…") when the list was fetched with `cards=1`. */
    val card: String? = null,
    // detail only
    val nextUpdate: String? = null,
    val slaEnd: String? = null,
    val rfpAt: String? = null,
    val outcomeReason: String? = null,
    val closedReason: String? = null,
    val soldAt: String? = null,
    /** `workorders.last_cart_value`: the sold value of a closed work order (the wire field is not in the API yet). */
    val lastCartValue: Double? = null,
    /** Waymark tags, oldest first (`[]` from a tracker that predates them). */
    val tags: List<WoTag> = emptyList(),
    /** Auto-Waymark follow-up (open rows and the detail; null when none or from an older tracker). */
    val followUp: FollowUp? = null,
) {
    val key: WoKey get() = WoKey(store, wo)
}

/** A work order's identity; [id] is the route argument and list-detail key ("914-7000001"). */
data class WoKey(val store: Int, val wo: Long) {
    val id: String get() = "$store-$wo"

    companion object {
        /** "914-7000001" (also "914:7000001" or "914/7000001"). */
        fun parse(id: String?): WoKey? {
            val parts = id?.trim()?.split('-', ':', '/')?.takeIf { it.size == 2 } ?: return null
            val s = parts[0].toIntOrNull() ?: return null
            val w = parts[1].toLongOrNull() ?: return null
            return WoKey(s, w)
        }
    }
}

@Serializable
data class WoLanes(val order: Int = 0, val start: Int = 0, val work: Int = 0, val wait: Int = 0, val rfp: Int = 0, val total: Int = 0) {
    fun count(lane: Lane): Int = when (lane) { Lane.Order -> order; Lane.Start -> start; Lane.Work -> work; Lane.Wait -> wait; Lane.Rfp -> rfp }
}

@Serializable
data class WoListResponse(
    val v: Int = 1,
    val now: String? = null,
    val state: String? = null,
    val sort: String? = null,
    val stores: List<Int> = emptyList(),
    val rows: List<WoRow> = emptyList(),
    val next: String? = null,
    val lanes: WoLanes? = null,
    val cards: Boolean = false,
    val cardsFor: List<Int> = emptyList(),
    val noKey: List<Int> = emptyList(),
    val closedDays: Int? = null,
    /** First page of an open list: the Follow-ups chip's count and the server's store-local "today". Absent on older trackers. */
    val followUps: FollowUpsInfo? = null,
)

@Serializable
data class WoFindResponse(val v: Int = 1, val now: String? = null, val q: String? = null, val rows: List<WoRow> = emptyList(), val more: Boolean = false)

@Serializable
data class TimelineEntry(
    val statusId: Int? = null,
    val status: String? = null,
    val lane: String? = null,
    val start: String? = null,
    val end: String? = null,
    val seconds: Long? = null,
    val current: Boolean = false,
)

@Serializable
data class CartLine(
    val name: String? = null,
    val sku: String? = null,
    val quantity: Double? = null,
    val price: Double? = null,
    val totalPrice: Double? = null,
    val partStatus: String? = null,
)

@Serializable
data class Cart(val value: Double? = null, val total: Double? = null, val paid: Double? = null, val due: Double? = null, val lines: List<CartLine> = emptyList())

@Serializable
data class SealedSnapshotRef(val id: Long? = null, val fetchedAt: String? = null, val sealed: String? = null)

@Serializable
data class SealedPart(val card: String? = null, val snapshot: SealedSnapshotRef? = null)

@Serializable
data class WoDetailResponse(
    val v: Int = 1,
    val now: String? = null,
    val wo: WoRow = WoRow(),
    val timeline: List<TimelineEntry> = emptyList(),
    val timelineSource: String? = null,
    val cart: Cart? = null,
    val sealed: SealedPart? = null,
    /** Parts sold on a closed work order; null from an older tracker. */
    val parts: WoParts? = null,
    /** Status and next-update changes, newest first; `[]` from an older tracker. */
    val changes: List<WoChange> = emptyList(),
)

/** The five open lanes, in the order Home shows them; the colour always travels with the name. */
enum class Lane(val key: String, val label: String) {
    Order("order", "Need to order"),
    Start("start", "Ready to start"),
    Work("work", "Work started"),
    Wait("wait", "Waiting"),
    Rfp("rfp", "Ready for pickup");

    companion object {
        fun of(key: String?): Lane? = entries.firstOrNull { it.key == key }
    }
}

/**
 * The list's filter: all open, one lane, open work orders with a follow-up due, or the Closed side of the Open / Closed switch
 * (`state=closed`, every closed work order, paged). [Recent] is the last 7 days of closed ones (`state=recent`) and is only used to
 * build the name search index; it has no chip.
 */
sealed interface LaneFilter {
    data object All : LaneFilter
    data class One(val lane: Lane) : LaneFilter
    data object FollowUps : LaneFilter
    data object Closed : LaneFilter
    data object Recent : LaneFilter
}

enum class WoSort(val key: String, val label: String) {
    Status("status", "Longest in status"),
    Updated("updated", "Last updated"),
    Closed("closed", "Last closed"),
}
