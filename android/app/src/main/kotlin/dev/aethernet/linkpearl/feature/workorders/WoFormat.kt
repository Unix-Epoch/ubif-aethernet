package dev.aethernet.linkpearl.feature.workorders

import dev.aethernet.linkpearl.core.design.Fmt
import java.time.DateTimeException
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.time.Duration

/** Work order formatting. Pure, JVM-tested. Null is a dash. */
object WoFmt {
    /** "5d 0h" / "2h 34m" / "34m" from [sinceIso] to [nowMs]; a dash when unknown. */
    fun inStatus(sinceIso: String?, nowMs: Long): String {
        val m = minutesSince(sinceIso, nowMs) ?: return Fmt.DASH
        return Fmt.ago(m)
    }

    fun minutesSince(sinceIso: String?, nowMs: Long): Double? {
        if (sinceIso == null) return null
        return try { (nowMs - Instant.parse(sinceIso).toEpochMilli()) / 60000.0 } catch (_: DateTimeException) { null }
    }

    /** The detail's chip: "5 days" from a day on, else "5h 12m". */
    fun inStatusLong(sinceIso: String?, nowMs: Long): String {
        val m = minutesSince(sinceIso, nowMs) ?: return Fmt.DASH
        val days = (m / 1440).toInt()
        return if (days >= 1) Fmt.days(days) else Fmt.ago(m)
    }

    /** Three days or more in one status is worth the amber emphasis (the time itself is the signal). */
    fun isLong(sinceIso: String?, nowMs: Long): Boolean = (minutesSince(sinceIso, nowMs) ?: 0.0) >= 3 * 1440

    fun seconds(s: Long?): String = if (s == null) Fmt.DASH else Fmt.ago(s / 60.0)

    /** "Fri, Nov 8 · 3:58 PM". */
    fun dayTime(iso: String?, zone: ZoneId): String = fmt(iso, zone, "EEE, MMM d") { d, t -> "$d${Fmt.DOT}$t" }

    /** "Nov 10 · 2:14 PM". */
    fun shortDayTime(iso: String?, zone: ZoneId): String = fmt(iso, zone, "MMM d") { d, t -> "$d${Fmt.DOT}$t" }

    private fun fmt(iso: String?, zone: ZoneId, dayPattern: String, join: (String, String) -> String): String {
        if (iso == null) return Fmt.DASH
        return try {
            val t = Instant.parse(iso).atZone(zone)
            join(t.format(DateTimeFormatter.ofPattern(dayPattern, Locale.US)), t.format(DateTimeFormatter.ofPattern("h:mm a", Locale.US)))
        } catch (_: DateTimeException) { Fmt.DASH }
    }

    /** "(757) 555-0142" for 10 digits; other lengths as given. */
    fun phone(digits: String): String =
        if (digits.length == 10) "(${digits.substring(0, 3)}) ${digits.substring(3, 6)}-${digits.substring(6)}" else digits

    /** "35••••••••••4821": the first two and the last four kept. */
    fun mask(value: String): String {
        if (value.length <= 6) return "•".repeat(value.length)
        return value.take(2) + "•".repeat(value.length - 6) + value.takeLast(4)
    }

    /** "28:14". */
    fun countdown(d: Duration?): String {
        if (d == null) return Fmt.DASH
        val s = d.inWholeSeconds.coerceAtLeast(0)
        return "%d:%02d".format(Locale.US, s / 60, s % 60)
    }

    fun money(v: Double?): String = if (v == null) Fmt.DASH else "$" + String.format(Locale.US, "%,.2f", v)

    fun portalUrl(wo: Long) = "https://portal.ubreakifix.net/repair/workorder/$wo"
}
