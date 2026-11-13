package dev.aethernet.linkpearl.feature.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.aethernet.linkpearl.core.data.ByStore
import dev.aethernet.linkpearl.core.data.HomeData
import dev.aethernet.linkpearl.core.design.BarChart
import dev.aethernet.linkpearl.core.design.BigValue
import dev.aethernet.linkpearl.core.design.CardLabel
import dev.aethernet.linkpearl.core.design.Fmt
import dev.aethernet.linkpearl.core.design.LineChart
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpCard
import dev.aethernet.linkpearl.core.design.LpDot
import dev.aethernet.linkpearl.core.design.LpIcon
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.design.MarkerBar
import dev.aethernet.linkpearl.core.design.ProgressBar
import dev.aethernet.linkpearl.core.design.SegmentBar
import dev.aethernet.linkpearl.core.design.Skeleton
import dev.aethernet.linkpearl.core.design.TargetChip
import dev.aethernet.linkpearl.core.design.label
import dev.aethernet.linkpearl.core.design.splhState

/** The cards of Home. [wide] = the two-column layout (bigger charts with values, list-style lanes). Numbers are text; charts are extra. */

private fun weekDescription(prefix: String, days: List<String>, values: List<Double?>, f: (Double) -> String) =
    prefix + ": " + values.mapIndexed { i, v -> (days.getOrNull(i)?.let(Fmt::dayName) ?: "") + " " + (v?.let(f) ?: "no data") }.joinToString(", ")

@Composable
fun SalesCard(d: HomeData, wide: Boolean, modifier: Modifier = Modifier) {
    val desc = weekDescription("Sales, last 7 days", d.days, d.sales.week) { Fmt.money(it) }
    LpCard(modifier) {
        CardLabel("Today's sales")
        if (wide) {
            BigValue(Fmt.money(d.sales.today))
            YesterdayLine(d)
            Spacer(Modifier.height(14.dp))
            BarChart(d.sales.week, d.days, desc, plotHeight = 130.dp, showValues = true, textSize = 12.sp)
        } else {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(LpSpacing.M), verticalAlignment = Alignment.Bottom) {
                Column(Modifier.weight(1f)) { BigValue(Fmt.money(d.sales.today)); YesterdayLine(d) }
                BarChart(d.sales.week, d.days, desc, Modifier.width(130.dp), plotHeight = 56.dp)
            }
        }
    }
}

@Composable
private fun YesterdayLine(d: HomeData) {
    Text(
        buildAnnotatedString {
            append("Yesterday ")
            withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(Fmt.money(d.sales.yesterday)) }
        },
        Modifier.padding(top = 8.dp), style = LpType.Row.copy(fontSize = 17.sp), color = Lp.colors.fg,
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SplhCard(d: HomeData, wide: Boolean, modifier: Modifier = Modifier) {
    val p = d.splh
    val state = splhState(p.today, p.target)
    val desc = weekDescription("Sales per labor hour, last 7 days", d.days, p.week) { Fmt.money(it) }
    LpCard(modifier) {
        CardLabel("Sales per labor hour", trailing = { Text("${Fmt.hours(p.hours)} labor hours", style = LpType.Small, color = Lp.colors.soft) })
        val targetRow: @Composable () -> Unit = {
            FlowRow(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                if (state != null) TargetChip(state)
                Text("Target ${Fmt.targetRange(p.target)}", style = LpType.Small, color = Lp.colors.soft)
            }
        }
        if (wide) {
            BigValue(Fmt.money(p.today))
            targetRow()
            Spacer(Modifier.height(14.dp))
            LineChart(p.week, d.days, p.target, desc, plotHeight = 120.dp, showValues = true, pointRadius = 4.dp, textSize = 12.sp)
        } else {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(LpSpacing.M), verticalAlignment = Alignment.Bottom) {
                Column(Modifier.weight(1f)) { BigValue(Fmt.money(p.today)); targetRow() }
                LineChart(p.week, d.days, p.target, desc, Modifier.width(130.dp), plotHeight = 34.dp)
            }
        }
        Spacer(Modifier.height(12.dp))
        MarkerBar(p.today, p.target, "Sales per labor hour ${Fmt.money(p.today)}${state?.let { ", " + it.label } ?: ""}, target ${Fmt.targetRange(p.target)}")
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RfpCard(d: HomeData, modifier: Modifier = Modifier) {
    val r = d.rfp
    LpCard(modifier) {
        CardLabel("RFP total")
        FlowRow(
            Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.SpaceBetween,
            verticalArrangement = Arrangement.spacedBy(8.dp), itemVerticalAlignment = Alignment.Bottom,
        ) {
            BigValue(Fmt.money(r.total))
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    buildAnnotatedString { withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(Fmt.count(r.count)) }; append(" Ready for pickup") },
                    style = LpType.Row, color = Lp.colors.fg,
                )
                if (r.count > 0 && r.oldestDays != null) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        LpIcon(LpIcons.Clock, null, size = 20.dp, tint = Lp.colors.fg)
                        Text(
                            buildAnnotatedString { append("Oldest "); withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(r.oldestDays.toString()) }; append(if (r.oldestDays == 1) " day" else " days") },
                            style = LpType.Row, color = Lp.colors.fg,
                        )
                    }
                }
            }
        }
    }
}

private class Lane(val name: String, val count: Int, val color: Color)

@Composable
private fun lanesOf(d: HomeData): List<Lane> = with(Lp.colors) {
    listOf(
        Lane("Need to order", d.lanes.order, warn), Lane("Ready to start", d.lanes.start, info), Lane("Work started", d.lanes.work, lilac),
        Lane("Waiting", d.lanes.wait, teal), Lane("Ready for pickup", d.lanes.rfp, good),
    )
}

@Composable
fun LanesCard(d: HomeData, wide: Boolean, modifier: Modifier = Modifier) {
    val lanes = lanesOf(d)
    val fontScale = LocalDensity.current.fontScale
    val asList = wide || fontScale > 1.15f
    LpCard(modifier) {
        CardLabel("Open work orders", trailing = { Text(Fmt.count(d.lanes.total), style = LpType.Small.copy(fontWeight = FontWeight.Bold), color = Lp.colors.fg) })
        if (!asList) {
            Spacer(Modifier.height(12.dp))
            SegmentBar(lanes.map { it.color to it.count }, lanes.joinToString(", ") { "${it.name} ${it.count}" })
            Spacer(Modifier.height(12.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                lanes.forEach { l ->
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            LpDot(l.color)
                            Text(Fmt.count(l.count), style = LpType.Value, color = Lp.colors.fg, maxLines = 1)
                        }
                        Text(l.name, Modifier.padding(top = 4.dp), style = LpType.Caption.copy(lineHeight = 18.sp), color = Lp.colors.soft)
                    }
                }
            }
        } else {
            val max = lanes.maxOf { it.count }.coerceAtLeast(1)
            Column(Modifier.padding(top = 8.dp)) {
                lanes.forEach { l ->
                    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            LpDot(l.color); Text(l.name, style = LpType.Row, color = Lp.colors.fg)
                        }
                        if (wide) ProgressBar(l.count.toFloat() / max, l.color, Modifier.width(110.dp))
                        Text(Fmt.count(l.count), Modifier.widthIn(min = 36.dp), style = LpType.Value.copy(fontSize = 26.sp), color = Lp.colors.fg, maxLines = 1)
                    }
                }
            }
        }
    }
}

@Composable
fun CleaningCard(d: HomeData, wide: Boolean, modifier: Modifier = Modifier) {
    val c = d.cleaning
    LpCard(modifier) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Column(Modifier.weight(1f)) {
                CardLabel("Cleaning rate")
                Text(Fmt.ordersOf(c.cln, c.am), Modifier.padding(top = 6.dp), style = LpType.Row.copy(fontSize = 17.sp), color = Lp.colors.fg)
            }
            Text(Fmt.percent(c.rate), style = LpType.Big, color = Lp.colors.fg, maxLines = 1)
        }
        Spacer(Modifier.height(12.dp))
        ProgressBar((c.rate ?: 0.0).toFloat(), Lp.colors.teal, contentDescription = "Cleaning rate ${Fmt.percent(c.rate)}")
        if (wide) {
            Spacer(Modifier.height(14.dp))
            BarChart(c.week, d.days, weekDescription("Cleaning rate, last 7 days", d.days, c.week) { Fmt.percent(it) }, plotHeight = 50.dp, cap = 1.0, valueFormat = { Fmt.percent(it) }, textSize = 12.sp)
        }
    }
}

/** Wide layouts only: By store (All stores) or Ready for pickup by age. */
@Composable
fun ExtraCard(d: HomeData, modifier: Modifier = Modifier) {
    if (d.byStore != null) ByStoreCard(d, d.byStore, modifier) else AgesCard(d, modifier)
}

@Composable
private fun AgesCard(d: HomeData, modifier: Modifier) {
    val max = d.rfp.ages.maxOfOrNull { it.n }?.coerceAtLeast(1) ?: 1
    LpCard(modifier) {
        CardLabel("Ready for pickup by age", trailing = { Text(Fmt.count(d.rfp.count), style = LpType.Small.copy(fontWeight = FontWeight.Bold), color = Lp.colors.fg) })
        Column(Modifier.padding(top = 8.dp)) {
            d.rfp.ages.forEach { a ->
                Row(Modifier.fillMaxWidth().heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(a.label, Modifier.width(120.dp), style = LpType.Body, color = Lp.colors.soft)
                    ProgressBar(a.n.toFloat() / max, Lp.colors.good, Modifier.weight(1f))
                    Text(a.n.toString(), Modifier.widthIn(min = 28.dp), style = LpType.BodyStrong, color = Lp.colors.fg, maxLines = 1)
                }
            }
        }
    }
}

@Composable
private fun ByStoreCard(d: HomeData, stores: List<ByStore>, modifier: Modifier) {
    LpCard(modifier) {
        CardLabel("By store")
        Column(Modifier.padding(top = 8.dp)) {
            stores.forEachIndexed { i, s ->
                if (i > 0) HorizontalDivider(color = Lp.colors.line)
                Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(s.label, style = LpType.Switcher, color = Lp.colors.fg)
                        val tint = if (s.stale) Lp.colors.warn else Lp.colors.soft
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            LpIcon(LpIcons.Clock, null, size = 18.dp, tint = tint)
                            Text(Fmt.clock(s.asOf, d.tz, d.today) + if (s.stale) "${Fmt.DOT}behind" else "", style = LpType.Small, color = tint)
                        }
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        Text(Fmt.money(s.sales), style = LpType.ValueMedium, color = Lp.colors.fg)
                        Text(if (s.splh == null) Fmt.DASH else Fmt.money(s.splh) + "/hr", style = LpType.Small, color = Lp.colors.soft)
                    }
                }
            }
        }
    }
}

// ---- loading skeletons ------------------------------------------------------------------------------------------------------

@Composable
fun SkeletonCard(modifier: Modifier = Modifier, chart: Boolean = false) {
    LpCard(modifier.clearAndSetSemantics { }) {
        Skeleton(width = 110.dp)
        Skeleton(Modifier.padding(top = 10.dp), width = 150.dp, height = 44.dp)
        Skeleton(Modifier.padding(top = 10.dp), width = 90.dp, height = 16.dp)
        if (chart) Skeleton(Modifier.padding(top = 14.dp).fillMaxWidth(), height = 72.dp)
    }
}

@Composable
fun SkeletonCardSmall(modifier: Modifier = Modifier) {
    LpCard(modifier.clearAndSetSemantics { }) {
        Skeleton(width = 110.dp)
        Skeleton(Modifier.padding(top = 10.dp), width = 150.dp, height = 44.dp)
    }
}
