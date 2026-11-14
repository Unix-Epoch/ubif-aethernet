package dev.aethernet.linkpearl.feature.workorders

import androidx.compose.ui.graphics.Color
import kotlinx.serialization.Serializable
import java.time.DateTimeException
import java.time.LocalDate

/*
 * Closed work orders and Auto-Waymark: the plain shapes of `tracker-worker/MOBILE-API-wo.md` (tags, followUp, followUps, parts, changes).
 * Every field is optional so a missing or new field (an older tracker) never breaks decoding.
 */

/** `wo_tags.tag` and the colour of that tag in the store's list (null for a one-off tag that is not in the list). */
@Serializable
data class WoTag(val tag: String = "", val color: String? = null)

/** The Waymark list colours by name (the admin site's palette); the server passes the stored colour on as it is (a name or a CSS hex). */
object TagColors {
    private val named = mapOf(
        "purple" to 0xFF8223D2, "blue" to 0xFF4A68F9, "teal" to 0xFF1592A8, "green" to 0xFF2F9E5B, "lime" to 0xFF6F9A12,
        "yellow" to 0xFFB38F00, "orange" to 0xFFD9670F, "red" to 0xFFD1344B, "grey" to 0xFF5D5E61,
    )

    /** The dot colour for a tag colour string; grey for a colour that is neither a known name nor `#rgb` / `#rrggbb`. */
    fun parse(color: String): Color {
        val c = color.trim().lowercase()
        named[c]?.let { return Color(it) }
        if (c.startsWith("#")) {
            val h = c.drop(1).let { if (it.length == 3) it.map { ch -> "$ch$ch" }.joinToString("") else it }
            if (h.length == 6) h.toLongOrNull(16)?.let { return Color(0xFF000000 or it) }
        }
        return Color(named.getValue("grey"))
    }
}

/** `auto_marks.kind`: rfp (Ready for pickup) or callback (the admin site calls it "Awaiting callback or device"). */
enum class FollowUpRule(val key: String, val label: String, val longLabel: String) {
    Rfp("rfp", "Ready for pickup", "Ready for pickup"),
    Callback("callback", "Callback", "Awaiting callback or device"),
}

enum class DueState { Overdue, Today, Upcoming }

/** One Auto-Waymark: [due] is the store-local day "YYYY-MM-DD". A kind the app does not know reads as Ready for pickup, as the server does. */
@Serializable
data class FollowUp(val kind: String? = null, val due: String = "") {
    val rule: FollowUpRule get() = if (kind == "callback") FollowUpRule.Callback else FollowUpRule.Rfp
    val valid: Boolean get() = runCatching { LocalDate.parse(due) }.isSuccess

    /** [today] is the store-local day "YYYY-MM-DD" (the server's `followUps.today` when it sent one). */
    fun state(today: String): DueState = when {
        due < today -> DueState.Overdue
        due == today -> DueState.Today
        else -> DueState.Upcoming
    }

    /** "Nov 10" */
    fun day(): String = try {
        LocalDate.parse(due).let { "${it.month.getDisplayName(java.time.format.TextStyle.SHORT, java.util.Locale.US)} ${it.dayOfMonth}" }
    } catch (_: DateTimeException) { due }
}

/** `followUps` on the first page of an open list: the chip's count and the server's "today". */
@Serializable
data class FollowUpsInfo(val count: Int? = null, val today: String? = null)

/** A part sold on a closed work order (`parts.rows`, from `inv_wo_parts`). */
@Serializable
data class WoPartRow(
    val line: String? = null,
    val label: String? = null,
    val item: String? = null,
    val sku: String? = null,
    val name: String? = null,
    val quantity: Double? = null,
    val price: Double? = null,
    val status: String? = null,
    val soldAt: String? = null,
)

/** `parts.state`: done | empty | pending | failed | gave_up, or null (not asked for yet). The card shows rows, or a dash when there are none. */
@Serializable
data class WoParts(val state: String? = null, val rows: List<WoPartRow> = emptyList())

/** One change row: [field] is "status" or "nextUpdate"; [old] / [new] are status names, or ISO times for nextUpdate. */
@Serializable
data class WoChange(val at: String? = null, val field: String? = null, val old: String? = null, val new: String? = null)
