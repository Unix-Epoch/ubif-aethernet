package dev.aethernet.linkpearl.feature.retrace

import androidx.compose.ui.graphics.vector.ImageVector
import dev.aethernet.linkpearl.core.data.StoreRef
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.Tone
import dev.aethernet.linkpearl.feature.workorders.LoadView
import dev.aethernet.linkpearl.feature.workorders.Problem
import kotlinx.serialization.Serializable

/*
 * Retrace: the plain shapes of `tracker-worker/MOBILE-API-retrace.md` (items, item, label, pos). Every field is optional so a missing or
 * new field never breaks decoding. No staff names and no customer or device identifiers are in any of these.
 */

/** Where a label stands now (`group` in the API; retrace-now.js groups, with the admin Retrace page's names). */
enum class NowGroup(val key: String, val label: String, val tone: Tone, val icon: ImageVector) {
    In("in", "In stock", Tone.Good, LpIcons.Check),
    Wo("wo", "Reserved", Tone.Lilac, LpIcons.Orders),
    Out("out", "Used, sold, moved", Tone.Info, LpIcons.Outbox),
    Q("q", "Defective & returns", Tone.Warn, LpIcons.Warning),
    Bad("bad", "Lost & missing", Tone.Warn, LpIcons.Close);

    companion object {
        /** null for a label Retrace does not map (the API sends `group: null`) or a group the app does not know yet. */
        fun of(key: String?): NowGroup? = entries.firstOrNull { it.key == key }
    }
}

/** A document a movement names: `refType` and `refId`. */
data class RtRef(val type: String, val id: String) {
    fun text(): String = when (type) {
        "po" -> "PO $id"
        "wo" -> "WO $id"
        "sales_order" -> "Sales order $id"
        "transfer" -> "Transfer $id"
        "rma" -> "RMA $id"
        "buyback" -> "Buyback $id"
        "count", "journal" -> "Count $id"
        else -> id
    }
}

/** `kind` in plain words (the admin Retrace page's names); a kind the app does not know is shown as plain text. */
object RtKinds {
    private val words = mapOf(
        "shipped_to_store" to "In transit to store", "received" to "Received", "adjusted_in" to "Adjusted in", "count_found" to "Counted", "transfer_in" to "Transfer in",
        "van_in" to "Back from van", "returned" to "Returned", "reserved" to "Reserved", "unreserved" to "Unreserved", "swapped_in" to "Swapped in", "swapped_out" to "Swapped out",
        "used" to "Used on repair", "sold" to "Sold", "transfer_out" to "Transfer out", "van_out" to "To van", "adjusted_out" to "Adjusted out", "defective" to "Defective",
        "quarantined" to "Quarantined", "rma" to "RMA", "buyback" to "Buyback", "salvage" to "Salvage", "consignment_changed" to "Consigned → owned", "lost" to "Lost",
        "count_missing" to "Missing at count", "status_changed" to "Status changed",
    )
    fun words(kind: String?): String = if (kind == null) "—" else words[kind] ?: kind.replace('_', ' ').replaceFirstChar { it.uppercase() }
}

/** One movement: `{ at, kind, refType, refId, label }`; [label] is null for an item-level movement. */
@Serializable
data class RtMovement(
    val at: String? = null,
    val kind: String? = null,
    val refType: String? = null,
    val refId: String? = null,
    val label: String? = null,
) {
    val ref: RtRef? get() = if (refType != null && refId != null) RtRef(refType, refId) else null
}

/** One row of the items list. [onHand] is null without a stock-lookup quantity; [available] then counts the labels standing Available. */
@Serializable
data class RtItemRow(
    val item: String = "",
    val name: String? = null,
    val category: String? = null,
    val available: Int? = null,
    val onHand: Int? = null,
    val lastAt: String? = null,
)

/** A label found by the label jump (`labels` on the first page of a label-shaped search). */
@Serializable
data class RtLabelHit(val label: String = "", val item: String? = null, val name: String? = null, val now: String? = null, val group: String? = null)

@Serializable
data class RtItemsResponse(
    val v: Int = 1,
    val now: String? = null,
    val store: Int? = null,
    val q: String? = null,
    val asOf: String? = null,
    val items: List<RtItemRow> = emptyList(),
    val next: String? = null,
    /** Absent unless `q` looked like a label (and this was the first page). */
    val labels: List<RtLabelHit>? = null,
)

@Serializable
data class RtItemInfo(val name: String? = null, val category: String? = null, val onHand: Int? = null, val available: Int? = null, val lastSeen: String? = null)

/** How many of the item's labels stand at [now] ([group] is a [NowGroup] key, or null when not mapped). */
@Serializable
data class RtCount(val now: String? = null, val group: String? = null, val n: Int = 0)

/** One label of an item: where it stands, the WO / PO it is tied to, its newest movement. */
@Serializable
data class RtItemLabel(
    val label: String = "",
    val now: String? = null,
    val group: String? = null,
    val wo: String? = null,
    val po: String? = null,
    val lastKind: String? = null,
    val lastAt: String? = null,
)

@Serializable
data class RtItemResponse(
    val v: Int = 1,
    val now: String? = null,
    val store: Int? = null,
    val item: String? = null,
    val info: RtItemInfo? = null,
    val counts: List<RtCount> = emptyList(),
    val labels: List<RtItemLabel> = emptyList(),
    val labelsTotal: Int? = null,
    val movements: List<RtMovement> = emptyList(),
) {
    /** The tiles: label counts added up per now-group (labels in an unmapped group are in no tile). */
    fun groupCounts(): Map<NowGroup, Int> = counts.mapNotNull { c -> NowGroup.of(c.group)?.let { it to c.n } }.groupBy({ it.first }, { it.second }).mapValues { it.value.sum() }
}

@Serializable
data class RtLabelRow(
    val label: String = "",
    val item: String? = null,
    val name: String? = null,
    val now: String? = null,
    val group: String? = null,
    val wo: String? = null,
    val po: String? = null,
    val salesOrder: String? = null,
)

/** A label: [row] is null when the tracker has movements for it but no label row (then only the timeline is shown). Movements oldest first. */
@Serializable
data class RtLabelResponse(
    val v: Int = 1,
    val now: String? = null,
    val store: Int? = null,
    val label: String? = null,
    val row: RtLabelRow? = null,
    val movements: List<RtMovement> = emptyList(),
    val movementsTotal: Int? = null,
)

/** A purchase order: Portal's [status] text as stored, [counterpart] as stored, [total] in dollars, [labels] / [received] null until read. */
@Serializable
data class RtPoRow(
    val po: String = "",
    val status: String? = null,
    val counterpart: String? = null,
    val date: String? = null,
    val labels: Int? = null,
    val received: Int? = null,
    val total: Double? = null,
)

@Serializable
data class RtPosResponse(
    val v: Int = 1,
    val now: String? = null,
    val store: Int? = null,
    val pos: List<RtPoRow> = emptyList(),
    val next: String? = null,
)

// ---- what the screens draw ---------------------------------------------------------------------------------------------------

enum class RetraceView { Items, PurchaseOrders }

/** Retrace home. One store at a time. [asOf] is the store's last sweep; [labels] the label jump results above the items. */
data class RetraceUi(
    val stores: List<StoreRef> = emptyList(),
    val store: Int? = null,
    val view: RetraceView = RetraceView.Items,
    val query: String = "",
    val load: LoadView = LoadView.Loading,
    val problem: Problem? = null,
    val items: List<RtItemRow> = emptyList(),
    val labels: List<RtLabelHit> = emptyList(),
    val pos: List<RtPoRow> = emptyList(),
    val asOf: String? = null,
    val hasMore: Boolean = false,
    val loadingMore: Boolean = false,
    val refreshing: Boolean = false,
    val receivedAtMs: Long? = null,
) {
    fun storeName(id: Int?): String = stores.firstOrNull { it.id == id }?.label ?: id?.let { "#$it" } ?: "—"
}

/** What a Retrace detail shows. */
sealed interface RtTarget {
    val store: Int
    data class Item(override val store: Int, val item: String) : RtTarget
    data class Label(override val store: Int, val label: String) : RtTarget
}

/** One detail's state: [data] is the item or label answer once loaded. */
data class RtDetailUi<T>(
    val stores: List<StoreRef> = emptyList(),
    val view: LoadView = LoadView.Loading,
    val problem: Problem? = null,
    val data: T? = null,
    val refreshing: Boolean = false,
) {
    fun storeName(id: Int): String = stores.firstOrNull { it.id == id }?.label ?: "#$id"
}
