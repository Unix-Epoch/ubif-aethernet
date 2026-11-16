package dev.aethernet.linkpearl.feature.workorders

import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.design.Fmt
import kotlinx.serialization.Serializable
import java.time.DateTimeException
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/*
 * Waymark from the phone: the shapes of `tracker-worker/MOBILE-API-waymark.md` (tag sheet, tag on/off, follow-up push/remove), the
 * follow-up date rules and the short error lines. Pure; JVM-tested.
 */

/** One tag of the store's managed list (`GET /m/waymark/tags`). */
@Serializable
data class ManagedTag(val name: String = "", val color: String? = null)

@Serializable
data class WaymarkTagsResponse(
    val v: Int = 1,
    val store: Int = 0,
    val tags: List<ManagedTag> = emptyList(),
    val oneOff: Boolean = true,
    val maxTags: Int = 12,
    val maxLength: Int = 32,
)

@Serializable
data class WaymarkTagResponse(
    val ok: Boolean = false,
    val store: Int = 0,
    val wo: Long = 0,
    val tag: String = "",
    val on: Boolean = false,
    val changed: Boolean = false,
    val tags: List<WoTag> = emptyList(),
)

@Serializable
data class WaymarkFollowUpResponse(val ok: Boolean = false, val store: Int = 0, val wo: Long = 0, val followUp: FollowUp? = null)

object WaymarkTags {
    const val MAX_LENGTH = 32
    const val MAX_TAGS = 12

    /** Waymark's cleaning: control characters out, whitespace collapsed, trimmed, cut to [max] characters. */
    fun clean(text: String, max: Int = MAX_LENGTH): String =
        text.filterNot { it.isISOControl() && it != ' ' }.replace(Regex("\\s+"), " ").trim().take(max).trim()

    /** The tag already on the work order that matches [name] apart from capitals, if any. */
    fun find(tags: List<WoTag>, name: String): WoTag? = tags.firstOrNull { it.tag.equals(name, ignoreCase = true) }

    /**
     * The sheet's rows: the managed list in the store's order, then the work order's one-off tags (not in the list). [on] marks the
     * ones on the work order.
     */
    fun rows(managed: List<ManagedTag>, on: List<WoTag>): List<TagRowUi> {
        val listed = managed.map { m -> TagRowUi(m.name, m.color, find(on, m.name) != null) }
        val extra = on.filter { t -> managed.none { it.name.equals(t.tag, ignoreCase = true) } }.map { TagRowUi(it.tag, it.color, true) }
        return listed + extra
    }
}

/** One row of the Tags sheet. [color] null = a one-off tag (an empty ring instead of a dot). */
data class TagRowUi(val name: String, val color: String?, val on: Boolean)

/** The follow-up date rules: a push is always later, at most a year ahead. Dates are store-local days. */
object FollowUpDates {
    val QUICK = listOf(1, 3, 7)
    private val dayFmt: DateTimeFormatter = DateTimeFormatter.ofPattern("EEE, MMM d", Locale.US)
    private val shortFmt: DateTimeFormatter = DateTimeFormatter.ofPattern("MMM d", Locale.US)

    fun parse(day: String?): LocalDate? = try { day?.let { LocalDate.parse(it) } } catch (_: DateTimeException) { null }

    /** max(today, current due) + [days]: never earlier than the current due, never in the past. */
    fun push(today: LocalDate, due: LocalDate, days: Int): LocalDate = maxOf(today, due).plusDays(days.toLong())

    /** The latest day the server takes. */
    fun latest(today: LocalDate): LocalDate = today.plusYears(1)

    /** The earliest day a picker offers: after the current due, and not before today. */
    fun earliest(today: LocalDate, due: LocalDate): LocalDate = maxOf(due.plusDays(1), today)

    fun allowed(day: LocalDate, today: LocalDate, due: LocalDate): Boolean = day > due && day >= today && day <= latest(today)

    /** "+1 day", "+3 days". */
    fun quickLabel(days: Int): String = if (days == 1) "+1 day" else "+$days days"

    /** "Sun, Nov 16". */
    fun dayLabel(day: LocalDate): String = day.format(dayFmt)

    /** The current state in words: "Overdue · Nov 10", "Due today", "Nov 18". */
    fun stateLabel(due: LocalDate, today: LocalDate): String = when {
        due < today -> "Overdue" + Fmt.DOT + due.format(shortFmt)
        due == today -> "Due today"
        else -> due.format(shortFmt)
    }
}

/** A short plain line for a failed Waymark write or read (snackbar). */
fun waymarkErrorText(f: ApiResult.Failure): String {
    val m = f.message.orEmpty().lowercase()
    return when {
        f.error == ApiError.Offline -> "Offline. Not saved."
        f.error == ApiError.RateLimited || f.status == 429 -> "Too many changes. Try later."
        f.status == 409 && "closed" in m -> "Work order is closed."
        f.status == 409 -> "Changed elsewhere. Reload."
        "too many tags" in m -> "${WaymarkTags.MAX_TAGS} tags at most."
        "only move later" in m -> "Pick a later date."
        "year ahead" in m -> "At most a year ahead."
        "no follow-up" in m -> "No follow-up to change."
        f.error == ApiError.NotFound -> "No such work order."
        "access to aethernet" in m -> "No Aethernet access."
        f.error == ApiError.Forbidden -> "Not your store."
        f.error == ApiError.Unauthorized -> "Signed out."
        f.error == ApiError.NotConfigured -> "Not connected yet."
        else -> "Couldn't save."
    }
}
