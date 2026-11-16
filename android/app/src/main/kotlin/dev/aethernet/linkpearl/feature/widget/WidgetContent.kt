package dev.aethernet.linkpearl.feature.widget

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalSize
import androidx.glance.action.Action
import androidx.glance.action.clickable
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.background
import androidx.glance.color.ColorProvider
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxHeight
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import dev.aethernet.linkpearl.R
import dev.aethernet.linkpearl.core.design.DarkLpColors
import dev.aethernet.linkpearl.core.design.LightLpColors
import dev.aethernet.linkpearl.core.design.LpColors
import dev.aethernet.linkpearl.core.design.TargetState
import dev.aethernet.linkpearl.core.design.label

/** The app's colour tokens (core/design Color.kt) as day/night pairs: the widget follows the phone's dark or light setting. */
internal object WColors {
    private fun pick(f: LpColors.() -> Color) = ColorProvider(day = LightLpColors.f(), night = DarkLpColors.f())
    val bg = ColorProvider(day = LightLpColors.surf, night = DarkLpColors.page)
    val fg = pick { fg }
    val soft = pick { soft }
    val line = pick { line }
    val bar = pick { bar }
    val barHi = pick { barHi }
    val good = pick { good }
    val goodBg = pick { goodBg }
    val warn = pick { warn }
    val warnBg = pick { warnBg }
    fun lane(l: Lane): ColorProvider = when (l) {
        Lane.Order -> pick { warn }
        Lane.Start -> pick { info }
        Lane.Work -> pick { lilac }
        Lane.Wait -> pick { teal }
        Lane.Rfp -> pick { good }
    }
}

/** The responsive sizes (dp). Each fits the Galaxy Z Fold cover screen as well as a phone's home screen. */
object WidgetSizes {
    /** Linkpearl: the 2-by-2 grid (cover screen, narrow cells) and the full card with the chart and lanes. */
    val GridSmall = DpSize(180.dp, 110.dp)
    val GridLarge = DpSize(300.dp, 140.dp)
    val Full = DpSize(320.dp, 200.dp)
    /** Today's sales. */
    val SalesSmall = DpSize(100.dp, 70.dp)
    val Sales = DpSize(150.dp, 120.dp)

    val linkpearl = setOf(GridSmall, GridLarge, Full)
    val sales = setOf(SalesSmall, Sales)
}

private fun style(size: TextUnit, color: ColorProvider = WColors.fg, weight: FontWeight = FontWeight.Normal) = TextStyle(color = color, fontSize = size, fontWeight = weight)

@Composable
private fun Root(onClick: Action?, padding: Dp, content: @Composable () -> Unit) {
    Box(
        GlanceModifier.fillMaxSize().appWidgetBackground().cornerRadius(28.dp).background(WColors.bg)
            .let { if (onClick != null) it.clickable(onClick) else it }.padding(padding),
    ) { content() }
}

@Composable
private fun Label(text: String, size: TextUnit = 14.sp) = Text(text, style = style(size, WColors.soft, FontWeight.Medium), maxLines = 1)

@Composable
private fun Value(text: String, size: TextUnit) = Text(text, style = style(size, WColors.fg, FontWeight.Bold), maxLines = 1)

@Composable
private fun Icon(res: Int, tint: ColorProvider, size: Dp) =
    Image(ImageProvider(res), contentDescription = null, modifier = GlanceModifier.size(size), colorFilter = ColorFilter.tint(tint))

/** Linkpearl (the large widget): picks its layout from the size the launcher gives it. */
@Composable
fun LinkpearlWidgetContent(ui: WidgetUi, onClick: Action? = null) {
    val size = LocalSize.current
    val full = size.width >= WidgetSizes.Full.width && size.height >= WidgetSizes.Full.height
    val large = size.width >= WidgetSizes.GridLarge.width && size.height >= WidgetSizes.GridLarge.height
    Root(onClick, if (full) 18.dp else if (large) 16.dp else 12.dp) {
        if (full) FullCard(ui) else GridCard(ui, large)
    }
}

@Composable
private fun FullCard(ui: WidgetUi) {
    Column(GlanceModifier.fillMaxSize()) {
        Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Icon(R.drawable.ic_widget_store, WColors.fg, 18.dp)
            Spacer(GlanceModifier.width(8.dp))
            Text(ui.store, style = style(15.sp, WColors.fg, FontWeight.Bold), maxLines = 1, modifier = GlanceModifier.defaultWeight())
            if (ui.asOf.isNotEmpty()) {
                Icon(R.drawable.ic_widget_clock, WColors.soft, 16.dp)
                Spacer(GlanceModifier.width(6.dp))
                Text(ui.asOf, style = style(14.sp, WColors.soft), maxLines = 1)
            }
        }
        Spacer(GlanceModifier.height(10.dp))
        Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
            Column(GlanceModifier.defaultWeight()) {
                Label("Today's sales")
                Value(ui.sales, 36.sp)
            }
            Bars(ui, height = 52.dp)
        }
        Spacer(GlanceModifier.height(10.dp))
        Box(GlanceModifier.fillMaxWidth().height(1.dp).background(WColors.line)) {}
        Spacer(GlanceModifier.height(10.dp))
        Row(GlanceModifier.fillMaxWidth().defaultWeight()) {
            Column(GlanceModifier.defaultWeight().fillMaxHeight()) {
                Label("Per labor hour")
                Value(ui.splh, 20.sp)
                ui.target?.let { Spacer(GlanceModifier.height(4.dp)); TargetPill(it) }
            }
            Spacer(GlanceModifier.width(8.dp))
            Column(GlanceModifier.defaultWeight().fillMaxHeight().semantics { contentDescription = ui.rfpDescription }) {
                Label("RFP total")
                Value(ui.rfpTotal, 20.sp)
                if (ui.rfpLine.isNotEmpty()) Text(ui.rfpLine, style = style(14.sp, WColors.soft), maxLines = 1)
            }
            Spacer(GlanceModifier.width(8.dp))
            Column(GlanceModifier.defaultWeight().fillMaxHeight()) {
                Label("Open")
                Value(ui.open, 20.sp)
                Spacer(GlanceModifier.height(8.dp))
                LaneStrip(ui, width = (LocalSize.current.width - 36.dp - 16.dp) / 3)
            }
        }
    }
}

/** The 2-by-2 grid: Sales, Per labor hr, RFP total, Open (the cover screen layout). */
@Composable
private fun GridCard(ui: WidgetUi, large: Boolean) {
    val v = if (large) 28.sp else 17.sp
    val l = if (large) 14.sp else 11.sp
    Column(GlanceModifier.fillMaxSize()) {
        Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(ui.store, style = style(l, WColors.soft, FontWeight.Bold), maxLines = 1, modifier = GlanceModifier.defaultWeight())
            if (ui.asOf.isNotEmpty()) Text(ui.asOf, style = style(l, WColors.soft), maxLines = 1)
        }
        if (large) Spacer(GlanceModifier.height(8.dp))
        Row(GlanceModifier.fillMaxWidth().defaultWeight()) {
            Cell("Sales", ui.sales, l, v)
            Cell("Per labor hr", ui.splh, l, v)
        }
        Row(GlanceModifier.fillMaxWidth().defaultWeight()) {
            Cell("RFP total", ui.rfpTotal, l, v)
            Cell("Open", ui.open, l, v)
        }
    }
}

@Composable
private fun androidx.glance.layout.RowScope.Cell(label: String, value: String, l: TextUnit, v: TextUnit) {
    Column(GlanceModifier.defaultWeight().fillMaxHeight(), verticalAlignment = Alignment.CenterVertically) {
        Label(label, l)
        Value(value, v)
    }
}

/** On target / Over target / Under target with its icon (the same rule and words as Home's chip). */
@Composable
private fun TargetPill(state: TargetState) {
    val (fg, bg, icon) = when (state) {
        TargetState.On -> Triple(WColors.good, WColors.goodBg, R.drawable.ic_widget_check)
        TargetState.Over -> Triple(WColors.good, WColors.goodBg, R.drawable.ic_widget_trend_up)
        TargetState.Under -> Triple(WColors.warn, WColors.warnBg, R.drawable.ic_widget_trend_down)
    }
    Row(GlanceModifier.cornerRadius(14.dp).background(bg).padding(start = 8.dp, end = 10.dp, top = 3.dp, bottom = 3.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, fg, 14.dp)
        Spacer(GlanceModifier.width(4.dp))
        Text(state.label, style = style(12.sp, fg, FontWeight.Bold), maxLines = 1)
    }
}

/** Seven bars, today's highlighted; a day without data is a short stub. */
@Composable
private fun Bars(ui: WidgetUi, height: Dp) {
    if (ui.bars.isEmpty()) return
    val n = ui.bars.size
    Row(GlanceModifier.width(12.dp * n + 5.dp * (n - 1)).height(height).semantics { contentDescription = ui.barsDescription }, verticalAlignment = Alignment.Bottom) {
        // No spacers: a Glance Row draws at most 10 children, so the gap is each bar's own leading padding.
        ui.bars.forEachIndexed { i, b ->
            val h = b.fraction?.let { (height * it).coerceAtLeast(4.dp) } ?: 3.dp
            Box(GlanceModifier.padding(start = if (i > 0) 5.dp else 0.dp)) {
                Box(GlanceModifier.width(12.dp).height(h).cornerRadius(4.dp).background(if (b.today) WColors.barHi else WColors.bar)) {}
            }
        }
    }
}

/** The open work orders by lane, in Home's lane colours (the counts are in the description; the strip is the picture). */
@Composable
private fun LaneStrip(ui: WidgetUi, width: Dp) {
    val total = ui.lanes.sumOf { it.second }
    if (total == 0) return
    val gap = 3.dp
    val room = (width - gap * (ui.lanes.size - 1)).coerceAtLeast(0.dp)
    Row(GlanceModifier.semantics { contentDescription = ui.lanesDescription }) {
        ui.lanes.forEachIndexed { i, (lane, n) ->
            Box(GlanceModifier.padding(start = if (i > 0) gap else 0.dp)) {
                Box(GlanceModifier.width((room * (n.toFloat() / total)).coerceAtLeast(6.dp)).height(6.dp).cornerRadius(3.dp).background(WColors.lane(lane))) {}
            }
        }
    }
}

/** Today's sales (the small widget): the figure and Yesterday. */
@Composable
fun SalesWidgetContent(ui: WidgetUi, onClick: Action? = null) {
    val size = LocalSize.current
    val big = size.width >= WidgetSizes.Sales.width && size.height >= WidgetSizes.Sales.height
    val small = if (big) 15.sp else 11.sp
    Root(onClick, if (big) 18.dp else 10.dp) {
        Column(GlanceModifier.fillMaxSize()) {
            Label("Today's sales", small)
            Box(GlanceModifier.fillMaxWidth().defaultWeight(), contentAlignment = Alignment.CenterStart) { Value(ui.sales, if (big) 36.sp else 20.sp) }
            Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Yesterday", style = style(small, WColors.soft), maxLines = 1, modifier = GlanceModifier.defaultWeight())
                Text(ui.yesterday, style = style(small, WColors.fg, FontWeight.Bold), maxLines = 1)
            }
        }
    }
}
