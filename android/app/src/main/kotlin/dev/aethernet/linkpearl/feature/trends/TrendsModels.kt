package dev.aethernet.linkpearl.feature.trends

import dev.aethernet.linkpearl.core.design.Fmt
import kotlinx.serialization.Serializable
import java.time.DateTimeException
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.temporal.TemporalAdjusters
import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor

/**
 * The Trends answer: `GET /v1/agents/m/trends` (`tracker-worker/MOBILE-API-trends.md`). Every figure may be null (no data: a dash, never 0);
 * unknown keys are ignored and missing ones are null, so a small change on the server is a change here only.
 */
@Serializable
data class TrendsData(
    val v: Int = 1,
    val period: String? = null,
    val tz: String? = null,
    val today: String? = null,
    val from: String? = null,
    val to: String? = null,
    val prevFrom: String? = null,
    val prevTo: String? = null,
    val prevThrough: String? = null,
    val asOf: String? = null,
    val sales: TrendSales? = null,
    val splh: TrendSplh? = null,
    val cleaning: TrendCleaning? = null,
    val rfp: TrendRfp? = null,
    /** All stores only: one row per approved store, in approval order. */
    val stores: List<TrendStore>? = null,
    /** No approved stores (`{v, stores: [], empty: true}`). */
    val empty: Boolean = false,
)

@Serializable
data class TrendPoint(val day: String? = null, val value: Double? = null)

@Serializable
data class TrendSales(
    val total: Double? = null,
    val prevTotal: Double? = null,
    val changePct: Double? = null,
    val days: List<TrendPoint> = emptyList(),
    val prevDays: List<TrendPoint> = emptyList(),
)

@Serializable
data class TrendTarget(val lo: Double = 160.0, val hi: Double = 180.0)

@Serializable
data class TrendSplh(
    val value: Double? = null,
    val prev: Double? = null,
    val hours: Double? = null,
    val target: TrendTarget? = null,
    val days: List<TrendPoint> = emptyList(),
)

/** [pct] and [prevPct] are percent (60 = 60%). */
@Serializable
data class TrendCleaning(val linked: Int? = null, val orders: Int? = null, val pct: Double? = null, val prevPct: Double? = null)

@Serializable
data class TrendRfp(val total: Double? = null, val count: Int? = null, val prevTotal: Double? = null)

@Serializable
data class TrendStore(
    val id: Int,
    val name: String? = null,
    val sales: Double? = null,
    val prevSales: Double? = null,
    val changePct: Double? = null,
    val splh: Double? = null,
    val hours: Double? = null,
) {
    val label: String get() = Fmt.storeLabel(id, name)
}

enum class TrendPeriod(val key: String, val label: String) { Week("week", "Week"), Month("month", "Month"), Year("year", "Year") }

/** Up, down or flat, for a change chip: the icon and the words carry it, the colour only repeats it. */
enum class Direction { Up, Down, Flat }

/** The calendar maths and the words of the Trends screen, kept apart from Compose so they are unit-tested. */
object TrendsFmt {
    private val MONTH = DateTimeFormatter.ofPattern("MMMM", Locale.US)
    private val MON = DateTimeFormatter.ofPattern("MMM", Locale.US)
    private val MON_DAY = DateTimeFormatter.ofPattern("MMM d", Locale.US)
    private val DAY_NAME = DateTimeFormatter.ofPattern("EEE", Locale.US)

    fun date(s: String?): LocalDate? = try { s?.let(LocalDate::parse) } catch (_: DateTimeException) { null }

    private fun round(v: Double): Long = floor(v + 0.5).toLong()

    /** The period that holds [day]: week = Sunday through Saturday (Portal's week), month, year. */
    fun range(period: TrendPeriod, day: LocalDate): Pair<LocalDate, LocalDate> = when (period) {
        TrendPeriod.Week -> {
            val from = day.with(TemporalAdjusters.previousOrSame(DayOfWeek.SUNDAY))
            from to from.plusDays(6)
        }
        TrendPeriod.Month -> day.withDayOfMonth(1) to day.with(TemporalAdjusters.lastDayOfMonth())
        TrendPeriod.Year -> day.withDayOfYear(1) to day.with(TemporalAdjusters.lastDayOfYear())
    }

    /** The pager's words: "Nov 8–14", "Oct 26–Nov 1", "November", "2026"; another year than [today]'s gets its year. */
    fun periodLabel(period: TrendPeriod, from: LocalDate, to: LocalDate, today: LocalDate?): String {
        val otherYear = today != null && to.year != today.year
        return when (period) {
            TrendPeriod.Week -> {
                val end = if (from.month == to.month) to.dayOfMonth.toString() else to.format(MON_DAY)
                from.format(MON_DAY) + "–" + end + if (otherYear) ", ${to.year}" else ""
            }
            TrendPeriod.Month -> from.format(MONTH) + if (otherYear) " ${from.year}" else ""
            TrendPeriod.Year -> from.year.toString()
        }
    }

    /** "Previous week" style words for TalkBack on the pager arrows. */
    fun unitWord(period: TrendPeriod) = when (period) { TrendPeriod.Week -> "week"; TrendPeriod.Month -> "month"; TrendPeriod.Year -> "year" }

    private fun ordinal(n: Int): String {
        val suffix = if (n % 100 in 11..13) "th" else when (n % 10) { 1 -> "st"; 2 -> "nd"; 3 -> "rd"; else -> "th" }
        return "$n$suffix"
    }

    /**
     * The words before the previous figure: "Last week by Fri", "October by the 15th", "2025 by Nov 15" while the period runs (the server
     * compares up to the same point), or "Last week" / "Week before", "October", "2025" for a period that is over.
     */
    fun compareLabel(period: TrendPeriod, d: TrendsData): String {
        val prevFrom = date(d.prevFrom)
        val through = date(d.prevThrough)
        val prevTo = date(d.prevTo)
        val running = through != null && prevTo != null && through < prevTo
        val current = date(d.today)?.let { t -> date(d.from)?.let { it <= t } == true && date(d.to)?.let { it >= t } == true } ?: false
        return when (period) {
            TrendPeriod.Week -> (if (current) "Last week" else "Week before") + if (running) " by ${through!!.format(DAY_NAME)}" else ""
            TrendPeriod.Month -> (prevFrom?.format(MONTH) ?: "Month before") + if (running) " by the ${ordinal(through!!.dayOfMonth)}" else ""
            TrendPeriod.Year -> (prevFrom?.year?.toString() ?: "Year before") + if (running) " by ${through!!.format(MON_DAY)}" else ""
        }
    }

    /** How many buckets of [days] have started by [today] (all of them for a period that is over; at least one). */
    fun elapsed(period: TrendPeriod, days: List<TrendPoint>, today: String?): Int {
        if (today == null) return days.size
        val key = if (period == TrendPeriod.Year) today.take(7) else today
        return days.count { it.day != null && it.day <= key }.coerceAtLeast(1).coerceAtMost(days.size)
    }

    /** A running total (a null bucket adds nothing; the line is "so far", never a 0 shown as data). */
    fun cumulative(values: List<Double?>): List<Double> {
        var sum = 0.0
        return values.map { sum += it ?: 0.0; sum }
    }

    /** Labels under the chart: day letters for a week, "Nov 1 · 15 · 30" for a month, month initials for a year. */
    fun axis(period: TrendPeriod, days: List<TrendPoint>): List<String> = when (period) {
        TrendPeriod.Week -> days.map { p -> p.day?.let(Fmt::dayLetter) ?: "" }
        TrendPeriod.Month -> {
            val first = date(days.firstOrNull()?.day)
            if (first == null || days.size < 3) emptyList()
            else listOf(first.format(MON_DAY), ((days.size - 1) / 2 + 1).toString(), days.size.toString())
        }
        TrendPeriod.Year -> days.map { p -> p.day?.let { runCatching { LocalDate.parse("$it-01").format(MON).take(1) }.getOrNull() } ?: "" }
    }

    /** One bucket's name for the chart bubble: "Thu Nov 12", "Nov 12", "Mar". */
    fun bucketName(period: TrendPeriod, day: String?): String = when (period) {
        TrendPeriod.Year -> day?.let { runCatching { LocalDate.parse("$it-01").format(MON) }.getOrNull() } ?: ""
        TrendPeriod.Week -> date(day)?.let { it.format(DAY_NAME) + " " + it.format(MON_DAY) } ?: ""
        TrendPeriod.Month -> date(day)?.format(MON_DAY) ?: ""
    }

    fun direction(delta: Double?): Direction? = when {
        delta == null -> null
        round(abs(delta)) == 0L -> Direction.Flat
        delta > 0 -> Direction.Up
        else -> Direction.Down
    }

    /** A change in percent without its sign ("8%"): the arrow says which way. */
    fun pct(changePct: Double?): String = if (changePct == null) Fmt.DASH else "${round(abs(changePct))}%"

    /** A change in percentage points ("4 pts"). */
    fun points(delta: Double?): String = if (delta == null) Fmt.DASH else round(abs(delta)).let { if (it == 1L) "1 pt" else "$it pts" }

    /** Percent as given by the server (60 = 60%). */
    fun percentValue(pct: Double?): String = if (pct == null) Fmt.DASH else "${round(pct)}%"

    fun signWord(d: Direction?): String = when (d) { Direction.Up -> "up "; Direction.Down -> "down "; else -> "" }
}
