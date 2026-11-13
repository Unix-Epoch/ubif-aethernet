package dev.aethernet.linkpearl.core.design

import java.time.DateTimeException
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor

/** Sales per labor hour against the target band. "On" and "Over" are positive; "Under" is the caution state. */
enum class TargetState { Under, On, Over }

/**
 * Formatting helpers shared by every screen. Rule: null means "no data" and is drawn as a dash, never 0.
 * Pure functions (no Android types) so they are unit-tested on the JVM.
 */
object Fmt {
    const val DASH = "—"
    const val DOT = " · "

    // JS Math.round semantics (half rounds up), to match the web app exactly.
    private fun round(v: Double): Long = floor(v + 0.5).toLong()

    fun count(n: Int?): String = if (n == null) DASH else String.format(Locale.US, "%,d", n)

    fun money(v: Double?): String {
        if (v == null) return DASH
        val r = round(v)
        return (if (r < 0) "-$" else "$") + String.format(Locale.US, "%,d", abs(r))
    }

    /** Chart labels: 2418 -> "2.4k", 850 -> "850". */
    fun compactMoney(v: Double): String = if (v >= 1000) String.format(Locale.US, "%.1fk", v / 1000) else round(v).toString()

    fun hours(v: Double?): String = if (v == null) DASH else String.format(Locale.US, "%.1f", round(v * 10) / 10.0)

    fun percent(rate: Double?): String = if (rate == null) DASH else "${round(rate * 100)}%"

    fun days(n: Int): String = if (n == 1) "1 day" else "$n days"

    fun targetRange(target: List<Int>): String = "$${target[0]}–$${target[1]}"

    /** "14 of 18 orders" or a dash. */
    fun ordersOf(cleaned: Int?, total: Int?): String = if (total == null || cleaned == null) DASH else "$cleaned of $total orders"

    /**
     * "4:12 PM"; with the weekday ("Thu 4:12 PM") when the day is not [today] in [tz].
     * [iso] is an ISO-8601 instant (UTC); [today] is a store-local "yyyy-MM-dd".
     */
    fun clock(iso: String?, tz: String, today: String? = null): String {
        if (iso == null) return DASH
        return try {
            val t = Instant.parse(iso).atZone(ZoneId.of(tz))
            var s = t.format(DateTimeFormatter.ofPattern("h:mm a", Locale.US))
            if (today != null && t.toLocalDate() != LocalDate.parse(today)) s = t.format(DateTimeFormatter.ofPattern("EEE", Locale.US)) + " " + s
            s
        } catch (_: DateTimeException) {
            DASH
        }
    }

    /** Minutes to "34m", "2h 34m", "1d 3h". */
    fun ago(minutes: Double): String {
        val m = round(minutes.coerceAtLeast(0.0))
        if (m < 60) return "${m}m"
        val h = m / 60
        return if (h < 24) "${h}h ${m % 60}m" else "${h / 24}d ${h % 24}h"
    }

    /** Minutes between two ISO instants, or null when either is missing or unreadable. */
    fun minutesBetween(fromIso: String?, toIso: String?): Double? {
        if (fromIso == null || toIso == null) return null
        return try {
            (Instant.parse(toIso).toEpochMilli() - Instant.parse(fromIso).toEpochMilli()) / 60000.0
        } catch (_: DateTimeException) {
            null
        }
    }

    // ---- the freshness line under the store switcher
    fun asOf(clock: String, behind: String? = null): String = "As of $clock" + (if (behind != null) "$DOT$behind behind" else "")
    fun stale(ago: String, clock: String): String = "Updated $ago ago${DOT}as of $clock"
    fun offline(clock: String): String = "Offline${DOT}as of $clock"
    fun couldntRefresh(clock: String): String = "Couldn't refresh${DOT}as of $clock"

    /** "S", "M", "T"... for a "yyyy-MM-dd" day (Sunday = S). */
    fun dayLetter(day: String): String = try { "SMTWTFS"[LocalDate.parse(day).dayOfWeek.value % 7].toString() } catch (_: DateTimeException) { "" }

    /** "Sun", "Mon"... for a "yyyy-MM-dd" day. */
    fun dayName(day: String): String = try { LocalDate.parse(day).format(DateTimeFormatter.ofPattern("EEE", Locale.US)) } catch (_: DateTimeException) { "" }

    /** "Name #id", or "#id" when the store has no name. */
    fun storeLabel(id: Int, name: String?): String = if (name.isNullOrBlank()) "#$id" else "$name #$id"
}

fun splhState(value: Double?, target: List<Int>): TargetState? = when {
    value == null -> null
    value < target[0] -> TargetState.Under
    value > target[1] -> TargetState.Over
    else -> TargetState.On
}

val TargetState.label: String
    get() = when (this) {
        TargetState.Under -> "Under target"
        TargetState.On -> "On target"
        TargetState.Over -> "Over target"
    }
