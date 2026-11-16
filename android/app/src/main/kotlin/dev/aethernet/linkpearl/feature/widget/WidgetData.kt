package dev.aethernet.linkpearl.feature.widget

import dev.aethernet.linkpearl.core.data.HomeData
import dev.aethernet.linkpearl.core.data.StoreScope
import dev.aethernet.linkpearl.core.design.Fmt
import dev.aethernet.linkpearl.core.design.TargetState
import dev.aethernet.linkpearl.core.design.splhState
import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.ZoneId

/**
 * What a widget keeps of one Home answer: store-level numbers only (no customer or staff data). Saved per store scope ("all" or a
 * store id) and drawn by every widget that shows that scope.
 */
@Serializable
data class WidgetSnapshot(
    val scope: String,
    val store: String,
    val asOf: String? = null,
    val tz: String = "America/New_York",
    val salesToday: Double? = null,
    val salesYesterday: Double? = null,
    /** Seven store-local days, oldest first (today last). */
    val week: List<Double?> = emptyList(),
    val splh: Double? = null,
    val target: List<Int> = listOf(160, 180),
    val rfpTotal: Double? = null,
    val rfpCount: Int = 0,
    val rfpOldestDays: Int? = null,
    /** Need to order, Ready to start, Work started, Waiting, Ready for pickup (Home's lane order and colours). */
    val lanes: List<Int> = emptyList(),
    val open: Int? = null,
) {
    companion object {
        const val ALL_STORES = "All stores"

        fun from(scope: StoreScope, d: HomeData): WidgetSnapshot = WidgetSnapshot(
            scope = scope.key,
            store = when (scope) {
                StoreScope.All -> ALL_STORES
                is StoreScope.One -> d.stores.firstOrNull { it.id == scope.id }?.label ?: "#${scope.id}"
            },
            asOf = d.asOf ?: d.now,
            tz = d.tz,
            salesToday = d.sales.today,
            salesYesterday = d.sales.yesterday,
            week = d.sales.week,
            splh = d.splh.today,
            target = d.splh.target.takeIf { it.size >= 2 } ?: listOf(160, 180),
            rfpTotal = d.rfp.total,
            rfpCount = d.rfp.count,
            rfpOldestDays = d.rfp.oldestDays,
            lanes = with(d.lanes) { listOf(order, start, work, wait, rfp) },
            open = d.lanes.total,
        )
    }
}

/** One bar of the 7-day chart: [fraction] of the week's highest day (null = no data), [today] = the highlighted last bar. */
data class WidgetBar(val fraction: Float?, val today: Boolean)

enum class Lane(val label: String) { Order("Need to order"), Start("Ready to start"), Work("Work started"), Wait("Waiting"), Rfp("Ready for pickup") }

/** The widget's text and chart values, ready to draw. A missing number is a dash, never 0. */
data class WidgetUi(
    val store: String,
    val asOf: String,
    val sales: String,
    val yesterday: String,
    val bars: List<WidgetBar>,
    val barsDescription: String,
    val splh: String,
    val target: TargetState?,
    val rfpTotal: String,
    /** "3 · 12 days": Ready for pickup count and the oldest one's age. */
    val rfpLine: String,
    val rfpDescription: String,
    val open: String,
    val lanes: List<Pair<Lane, Int>>,
    val lanesDescription: String,
) {
    companion object {
        /** Nothing saved yet (just placed, or signed out): the app's name and dashes. */
        val Empty = WidgetUi(
            store = "Linkpearl", asOf = "", sales = Fmt.DASH, yesterday = Fmt.DASH, bars = emptyList(), barsDescription = "",
            splh = Fmt.DASH, target = null, rfpTotal = Fmt.DASH, rfpLine = "", rfpDescription = "", open = Fmt.DASH, lanes = emptyList(), lanesDescription = "",
        )

        fun from(s: WidgetSnapshot?, nowMs: Long = System.currentTimeMillis()): WidgetUi {
            if (s == null) return Empty
            val today = runCatching { Instant.ofEpochMilli(nowMs).atZone(ZoneId.of(s.tz)).toLocalDate().toString() }.getOrNull()
            val max = s.week.filterNotNull().maxOrNull()?.takeIf { it > 0 }
            val bars = s.week.mapIndexed { i, v -> WidgetBar(v?.let { if (max == null) 0f else (it / max).toFloat().coerceIn(0f, 1f) }, i == s.week.lastIndex) }
            val lanes = Lane.entries.zip(s.lanes).filter { it.second > 0 }
            return WidgetUi(
                store = s.store,
                asOf = if (s.asOf == null) "" else Fmt.clock(s.asOf, s.tz, today),
                sales = Fmt.money(s.salesToday),
                yesterday = Fmt.money(s.salesYesterday),
                bars = bars,
                barsDescription = "Sales, last 7 days: " + s.week.joinToString(", ") { Fmt.money(it) },
                splh = Fmt.money(s.splh),
                target = s.target.takeIf { it.size >= 2 }?.let { splhState(s.splh, it) },
                rfpTotal = Fmt.money(s.rfpTotal),
                rfpLine = Fmt.count(s.rfpCount) + (s.rfpOldestDays?.takeIf { s.rfpCount > 0 }?.let { Fmt.DOT + Fmt.days(it) } ?: ""),
                rfpDescription = "${Fmt.count(s.rfpCount)} ready for pickup" + (s.rfpOldestDays?.takeIf { s.rfpCount > 0 }?.let { ", oldest ${Fmt.days(it)}" } ?: ""),
                open = Fmt.count(s.open),
                lanes = lanes,
                lanesDescription = lanes.joinToString(", ") { "${it.first.label} ${it.second}" },
            )
        }
    }
}
