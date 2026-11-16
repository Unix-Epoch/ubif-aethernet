package dev.aethernet.linkpearl.feature.workorders

import dev.aethernet.linkpearl.core.design.Fmt

/**
 * Spread's old-card rule (`src/59-spread.js` COLUMNS `oldHours`), on the time in status the list shows: Waiting and Ready for pickup
 * 7 days, every other open status 3 days. The status grouping is Spread's (and the server's `lane`): 2 Need to order; 8, 24 Ready to
 * start; 9 to 12 Work started; 13 Ready for pickup; 3, 4, 7 and any other or missing status Waiting. Pure, JVM-tested.
 */
object WoAging {
    /** The shortest limit: a card younger than this is never old, whatever its status. */
    const val MIN_DAYS = 3
    const val LONG_DAYS = 7

    /** Spread's column for a status id; null or unknown is Waiting, as Spread does. */
    fun laneOf(statusId: Int?): Lane = when (statusId) {
        2 -> Lane.Order
        8, 24 -> Lane.Start
        9, 10, 11, 12 -> Lane.Work
        13 -> Lane.Rfp
        else -> Lane.Wait
    }

    /** The limit in days: by the status id when the row has one, else by the server's lane, else Waiting. */
    fun limitDays(statusId: Int?, lane: String?): Int {
        val l = if (statusId != null) laneOf(statusId) else Lane.of(lane) ?: Lane.Wait
        return if (l == Lane.Wait || l == Lane.Rfp) LONG_DAYS else MIN_DAYS
    }

    /** Minutes in status, or null when unknown (no time, unparsable). */
    fun minutes(row: WoRow, nowMs: Long): Double? = WoFmt.minutesSince(row.statusSince, nowMs)

    /** An open work order at or past its limit. No time in status = not old (Spread: no time, no mark). */
    fun isOld(row: WoRow, nowMs: Long): Boolean {
        if (!row.open) return false
        val m = minutes(row, nowMs) ?: return false
        return m >= limitDays(row.statusId, row.lane) * 1440.0
    }

    /** "Old · 9d 3h". */
    fun label(row: WoRow, nowMs: Long): String = "Old" + Fmt.DOT + WoFmt.inStatus(row.statusSince, nowMs)
}
