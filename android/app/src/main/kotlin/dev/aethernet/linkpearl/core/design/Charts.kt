package dev.aethernet.linkpearl.core.design

import android.graphics.BlurMaskFilter
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import kotlinx.coroutines.delay
import kotlin.math.roundToInt
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.max
import kotlin.math.min

// ---------------------------------------------------------------------------------------------------------------------------
// Charts, drawn with Canvas. Every chart takes a contentDescription (TalkBack reads it); the same numbers are also real text in the
// cards, so nothing is conveyed by the drawing alone. Null values mean "no data": no bar, no point.
// ---------------------------------------------------------------------------------------------------------------------------

private fun chartStyle(color: Color, size: TextUnit, bold: Boolean) =
    TextStyle(color = color, fontSize = size, fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal, fontFeatureSettings = "tnum")

private fun DrawScope.centred(m: TextMeasurer, text: String, style: TextStyle, cx: Float, y: Float, minX: Float = 0f, maxX: Float = size.width) {
    val r = m.measure(text, style, maxLines = 1)
    val x = (cx - r.size.width / 2f).coerceIn(minX, max(minX, maxX - r.size.width))
    drawText(r, topLeft = Offset(x, y))
}

@Composable
private fun labelHeight(size: TextUnit): Dp {
    val m = rememberTextMeasurer()
    val d = LocalDensity.current
    return with(d) { m.measure("0", chartStyle(Color.Black, size, false)).size.height.toDp() }
}

/** 0 to 1 when first shown and again whenever [key] changes (new data): drives the grow / draw-in of a chart. 1 when motion is off. */
@Composable
fun rememberGrow(key: Any?, delayMs: Long = 0L, spec: androidx.compose.animation.core.AnimationSpec<Float>? = null): Float {
    val motion = motionOn()
    val p = remember { Animatable(if (motion) 0f else 1f) }
    LaunchedEffect(key, motion) {
        if (!motion) { p.snapTo(1f); return@LaunchedEffect }
        p.snapTo(0f); if (delayMs > 0) delay(delayMs)
        p.animateTo(1f, spec ?: spring(dampingRatio = 0.8f, stiffness = 90f))
    }
    return p.value
}

/** A soft glow under a shape: the native paint's blur (hardware-accelerated from API 28; minSdk is 31). */
private fun DrawScope.glowRoundRect(color: Color, topLeft: Offset, size: Size, radius: Float, blur: Float) {
    drawIntoCanvas { canvas ->
        val paint = Paint().asFrameworkPaint().apply {
            isAntiAlias = true
            this.color = color.toArgb()
            maskFilter = BlurMaskFilter(blur, BlurMaskFilter.Blur.NORMAL)
        }
        canvas.nativeCanvas.drawRoundRect(topLeft.x, topLeft.y, topLeft.x + size.width, topLeft.y + size.height, radius, radius, paint)
    }
}

/**
 * Seven (or n) bars over day letters. The last bar (today) is the highlighted one: a gradient with a soft glow. Bars grow in one
 * after another when shown and when the values change. A value of 0 draws a short stub, null draws nothing.
 * [showValues] writes compact values above the bars (wide layouts). [cap] raises the scale's top (1.0 for rates).
 */
@Composable
fun BarChart(
    values: List<Double?>,
    days: List<String>,
    contentDescription: String,
    modifier: Modifier = Modifier,
    plotHeight: Dp = 56.dp,
    showValues: Boolean = false,
    valueFormat: (Double) -> String = Fmt::compactMoney,
    cap: Double? = null,
    textSize: TextUnit = 11.sp,
) {
    val c = Lp.colors
    val measurer = rememberTextMeasurer()
    val lh = labelHeight(textSize)
    val topPad = if (showValues) lh + 7.dp else 6.dp
    val total = topPad + plotHeight + 6.dp + lh + 4.dp
    val grow = rememberGrow(values)
    Canvas(modifier.fillMaxWidth().height(total).clearAndSetSemantics { this.contentDescription = contentDescription }) {
        val n = values.size
        if (n == 0) return@Canvas
        val barW = size.width / (n + (n - 1) * 0.42f)
        val gap = barW * 0.42f
        val maxV = max(max(cap ?: 0.0, 1.0), values.filterNotNull().maxOrNull() ?: 0.0)
        val plotH = plotHeight.toPx()
        val top = topPad.toPx()
        val stub = 3.dp.toPx()
        val radius = min(barW * 0.34f, 10.dp.toPx())
        val stagger = 0.08f
        values.forEachIndexed { i, v ->
            val x = i * (barW + gap)
            val last = i == n - 1
            // Each bar's own progress: later bars start a little later.
            val p = ((grow * (1f + stagger * (n - 1)) - i * stagger)).coerceIn(0f, 1.2f)
            if (v != null) {
                val full = if (v > 0) max(stub, (v / maxV).toFloat() * plotH) else stub
                val h = max(if (full > stub) 0f else stub, full * p)
                val y = top + plotH - h
                if (h > 0.5f) {
                    val cr = CornerRadius(min(radius, h / 2))
                    if (last) {
                        glowRoundRect(c.barHi.copy(alpha = if (c.isDark) 0.55f else 0.35f), Offset(x, y + h * 0.15f), Size(barW, h * 0.85f), radius, 14.dp.toPx())
                        drawRoundRect(Brush.verticalGradient(listOf(c.peach, c.barHi), startY = y, endY = y + h), Offset(x, y), Size(barW, h), cr)
                    } else {
                        val a = if (v > 0) 1f else 0.7f
                        drawRoundRect(Brush.verticalGradient(listOf(lerp(c.bar, c.fg, if (c.isDark) 0.12f else 0f).copy(alpha = a), c.bar.copy(alpha = a)), startY = y, endY = y + h), Offset(x, y), Size(barW, h), cr)
                    }
                }
                if (showValues && v > 0 && p > 0.6f) {
                    val st = chartStyle(if (last) c.fg else c.soft, textSize, last)
                    val r = measurer.measure(valueFormat(v), st, maxLines = 1)
                    drawText(r, topLeft = Offset(x + barW / 2 - r.size.width / 2f, top + plotH - full - 5.dp.toPx() - r.size.height), alpha = ((p - 0.6f) / 0.4f).coerceIn(0f, 1f))
                }
            }
            if (i < days.size) centred(measurer, Fmt.dayLetter(days[i]), chartStyle(if (last) c.fg else c.soft, textSize, last), x + barW / 2, top + plotH + 6.dp.toPx())
        }
    }
}

/**
 * Line over the target band, one point per day, today's point highlighted with a pulsing ring. Gaps (null) break the line. The
 * line draws itself in from the left and a soft fill sits under it. [target] is [low, high] in dollars.
 */
@Composable
fun LineChart(
    values: List<Double?>,
    days: List<String>,
    target: List<Int>,
    contentDescription: String,
    modifier: Modifier = Modifier,
    plotHeight: Dp = 34.dp,
    showValues: Boolean = false,
    pointRadius: Dp = 2.5.dp,
    textSize: TextUnit = 11.sp,
) {
    val c = Lp.colors
    val measurer = rememberTextMeasurer()
    val lh = labelHeight(textSize)
    val topPad = if (showValues) lh + 12.dp else 5.dp
    val bottomPad = if (showValues) lh + 10.dp else 0.dp // a label under a low point sits here, clear of the day letters
    val total = topPad + plotHeight + bottomPad + 6.dp + lh + 4.dp
    val draw = rememberGrow(values, spec = tween(1100, easing = FastOutSlowInEasing))
    val pulse = rememberPulse()
    Canvas(modifier.fillMaxWidth().height(total).clearAndSetSemantics { this.contentDescription = contentDescription }) {
        val n = values.size
        if (n < 2) return@Canvas
        val pad = 8.dp.toPx()
        val xs = { i: Int -> pad + i * (size.width - 2 * pad) / (n - 1) }
        val real = values.filterNotNull()
        val lo = min(target[0].toDouble(), real.minOrNull() ?: target[0].toDouble()) - 8
        val hi = max(target[1].toDouble(), real.maxOrNull() ?: target[1].toDouble()) + 8
        val top = topPad.toPx()
        val plotH = plotHeight.toPx()
        val y = { v: Double -> top + ((1 - (v - lo) / (hi - lo)) * plotH).toFloat() }
        // band: a soft green wash with a dashed edge
        val by0 = y(target[1].toDouble()); val by1 = y(target[0].toDouble())
        drawRoundRect(c.good.copy(alpha = 0.10f), Offset(0.5f, by0), Size(size.width - 1f, by1 - by0), CornerRadius(4.dp.toPx()))
        drawRoundRect(c.good.copy(alpha = 0.7f), Offset(0.5f, by0), Size(size.width - 1f, by1 - by0), CornerRadius(4.dp.toPx()), style = Stroke(1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 3.dp.toPx()))))
        // line (and the fill under each unbroken run)
        val path = Path()
        val runs = mutableListOf<MutableList<Offset>>()
        values.forEachIndexed { i, v ->
            if (v == null) return@forEachIndexed
            val p = Offset(xs(i), y(v))
            if (i > 0 && values[i - 1] != null) { path.lineTo(p.x, p.y); runs.last() += p } else { path.moveTo(p.x, p.y); runs += mutableListOf(p) }
        }
        val reveal = size.width * draw
        clipRect(right = reveal + pad) {
            runs.filter { it.size > 1 }.forEach { run ->
                val area = Path().apply { moveTo(run.first().x, top + plotH); run.forEach { lineTo(it.x, it.y) }; lineTo(run.last().x, top + plotH); close() }
                drawPath(area, Brush.verticalGradient(listOf(c.barHi.copy(alpha = 0.28f), c.barHi.copy(alpha = 0f)), startY = top, endY = top + plotH))
            }
            drawPath(path, Brush.horizontalGradient(listOf(c.lilac, c.peach)), style = Stroke(2.5.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
        // points
        values.forEachIndexed { i, v ->
            if (v == null) return@forEachIndexed
            val p = Offset(xs(i), y(v))
            if (p.x > reveal + pad) return@forEachIndexed
            if (i == n - 1) {
                drawCircle(c.barHi.copy(alpha = 0.35f * (1f - pulse)), pointRadius.toPx() * (1.4f + 2.2f * pulse), p)
                drawCircle(c.fg, pointRadius.toPx() * 1.25f, p)
                drawCircle(c.barHi, pointRadius.toPx() * 1.25f, p, style = Stroke(2.dp.toPx()))
            } else {
                drawCircle(c.cardTop, pointRadius.toPx(), p)
                drawCircle(c.fg.copy(alpha = 0.8f), pointRadius.toPx(), p, style = Stroke(1.5.dp.toPx()))
            }
        }
        // value labels: above a point, or below a low one; whichever side clears the other labels, the line and the band's edges
        if (showValues && draw > 0.9f) {
            val gap = 10.dp.toPx()
            val pts = values.mapIndexed { i, v -> v?.let { Offset(xs(i), y(it)) } }
            val placed = mutableListOf<Rect>()
            fun crossesLine(r: Rect): Boolean = (1 until n).any { i ->
                val a = pts[i - 1] ?: return@any false; val b = pts[i] ?: return@any false
                (0..16).any { k -> r.contains(Offset(a.x + (b.x - a.x) * k / 16f, a.y + (b.y - a.y) * k / 16f)) }
            }
            fun crossesBand(r: Rect) = (by0 > r.top && by0 < r.bottom) || (by1 > r.top && by1 < r.bottom)
            values.forEachIndexed { i, v ->
                if (v == null) return@forEachIndexed
                val p = pts[i]!!
                val last = i == n - 1
                val t = measurer.measure(Fmt.money(v), chartStyle(if (last) c.fg else c.soft, textSize, last), maxLines = 1)
                val x = (p.x - t.size.width / 2f).coerceIn(0f, size.width - t.size.width)
                val above = Rect(Offset(x, p.y - gap - t.size.height / 2f), Size(t.size.width.toFloat(), t.size.height.toFloat()))
                val below = above.translate(0f, 2 * gap)
                val near = listOfNotNull(values.getOrNull(i - 1), values.getOrNull(i + 1))
                val low = near.isNotEmpty() && near.all { it > v }
                val sides = if (low) listOf(below, above) else listOf(above, below)
                fun cost(r: Rect) = placed.count { it.overlaps(r) } * 4 + (if (crossesLine(r)) 2 else 0) + (if (crossesBand(r)) 1 else 0)
                val r = sides.minBy { cost(it) } // minBy keeps the first (preferred) side on a tie
                placed += r
                drawText(t, topLeft = r.topLeft, alpha = ((draw - 0.9f) / 0.1f).coerceIn(0f, 1f))
            }
        }
        values.indices.forEach { i ->
            if (i < days.size) centred(measurer, Fmt.dayLetter(days[i]), chartStyle(if (i == n - 1) c.fg else c.soft, textSize, i == n - 1), xs(i), top + plotH + bottomPad.toPx() + 6.dp.toPx())
        }
    }
}

/** 0..1 repeating every 2 s (the "live" ring on the latest point). 0 when motion is off. */
@Composable
fun rememberPulse(): Float = if (motionOn()) {
    rememberInfiniteTransition(label = "pulse").animateFloat(0f, 1f, infiniteRepeatable(tween(2000, easing = LinearOutSlowInEasing), RepeatMode.Restart), label = "p").value
} else 0f

/** $120-$220 track with the target band outlined and a marker above today's value. A null [value] draws no marker. */
@Composable
fun MarkerBar(
    value: Double?,
    target: List<Int>,
    contentDescription: String,
    modifier: Modifier = Modifier,
    min: Int = 120,
    max: Int = 220,
    textSize: TextUnit = 12.sp,
) {
    val c = Lp.colors
    val measurer = rememberTextMeasurer()
    val lh = labelHeight(textSize)
    val grow = rememberGrow(value, delayMs = 150)
    Canvas(modifier.fillMaxWidth().height(36.dp + lh + 4.dp).clearAndSetSemantics { this.contentDescription = contentDescription }) {
        val w = size.width
        val x = { a: Double -> (((a.coerceIn(min.toDouble(), max.toDouble())) - min) / (max - min)).toFloat() * w }
        val trackY = 20.dp.toPx()
        drawRoundRect(c.surf3, Offset(0f, trackY), Size(w, 12.dp.toPx()), CornerRadius(6.dp.toPx()))
        val x0 = x(target[0].toDouble()); val x1 = x(target[1].toDouble())
        drawRoundRect(c.good.copy(alpha = 0.18f), Offset(x0, 17.dp.toPx()), Size(x1 - x0, 18.dp.toPx()), CornerRadius(6.dp.toPx()))
        drawRoundRect(c.good, Offset(x0, 17.dp.toPx()), Size(x1 - x0, 18.dp.toPx()), CornerRadius(6.dp.toPx()), style = Stroke(2.dp.toPx()))
        if (value != null) {
            val mx = x(min.toDouble()) + (x(value) - x(min.toDouble())) * grow
            val tri = Path().apply { moveTo(mx - 8.dp.toPx(), 1.dp.toPx()); lineTo(mx + 8.dp.toPx(), 1.dp.toPx()); lineTo(mx, 12.dp.toPx()); close() }
            drawPath(tri, c.fg)
        }
        val ly = 38.dp.toPx()
        val plain = chartStyle(c.soft, textSize, false)
        val bold = chartStyle(c.soft, textSize, true)
        measurer.measure("$$min", plain).let { drawText(it, topLeft = Offset(0f, ly)) }
        centred(measurer, "$${target[0]}", bold, x0, ly)
        centred(measurer, "$${target[1]}", bold, x1, ly)
        measurer.measure("$$max", plain).let { drawText(it, topLeft = Offset(w - it.size.width, ly)) }
    }
}

/** A segmented bar: one segment per positive count, widths proportional, 4dp gaps. Grows in from the left. */
@Composable
fun SegmentBar(segments: List<Pair<Color, Int>>, contentDescription: String, modifier: Modifier = Modifier) {
    val shown = segments.filter { it.second > 0 }
    val grow = rememberGrow(segments.map { it.second })
    Row(
        modifier.fillMaxWidth().height(14.dp).graphicsLayer { scaleX = grow.coerceIn(0f, 1.05f); transformOrigin = TransformOrigin(0f, 0.5f) }
            .clearAndSetSemantics { this.contentDescription = contentDescription },
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        shown.forEach { (color, n) -> Box(Modifier.weight(n.toFloat()).fillMaxHeight().clip(RoundedCornerShape(7.dp)).background(Brush.verticalGradient(listOf(lerp(color, Color.White, 0.18f), color)))) }
    }
}

/** Track with a filled part, [fraction] 0..1 (values above 1 are capped); the fill grows to its value. Hidden from TalkBack unless [contentDescription] is given. */
@Composable
fun ProgressBar(fraction: Float, color: Color, modifier: Modifier = Modifier, contentDescription: String? = null, growKey: Any? = fraction) {
    val f = fraction.coerceIn(0f, 1f)
    // [growKey]: when it changes the bar grows in again (default: every new value). A live progress passes a fixed key so it grows once and then follows.
    val grow = rememberGrow(growKey, delayMs = 120)
    Box(
        modifier.fillMaxWidth().height(14.dp).clip(RoundedCornerShape(7.dp)).background(Lp.colors.surf3)
            .let { if (contentDescription != null) it.semantics { this.contentDescription = contentDescription } else it.clearAndSetSemantics { } },
    ) {
        if (f > 0f) Box(Modifier.fillMaxHeight().fillMaxWidth((f * grow).coerceIn(0f, 1f)).clip(RoundedCornerShape(7.dp)).background(Brush.horizontalGradient(listOf(lerp(color, Lp.colors.page, 0.25f), color))))
    }
}

/** A small trend line with a soft fill and a dot on the latest value (tiles, widgets). Decorative unless [contentDescription] is given. */
@Composable
fun Sparkline(values: List<Double?>, color: Color, modifier: Modifier = Modifier, contentDescription: String? = null) {
    val draw = rememberGrow(values, delayMs = 200, spec = tween(1000, easing = FastOutSlowInEasing))
    Canvas(modifier.fillMaxWidth().height(34.dp).let { m -> if (contentDescription != null) m.clearAndSetSemantics { this.contentDescription = contentDescription } else m.clearAndSetSemantics { } }) {
        val pts = values.mapIndexedNotNull { i, v -> v?.let { i to it } }
        if (pts.size < 2) return@Canvas
        val lo = pts.minOf { it.second }; val hi = pts.maxOf { it.second }
        val span = if (hi - lo < 1e-9) 1.0 else hi - lo
        val pad = 4.dp.toPx()
        val n = values.size
        val xy = pts.map { (i, v) -> Offset(pad + i * (size.width - 2 * pad) / (n - 1), pad + ((1 - (v - lo) / span) * (size.height - 2 * pad)).toFloat()) }
        val line = Path().apply { moveTo(xy[0].x, xy[0].y); xy.drop(1).forEach { lineTo(it.x, it.y) } }
        val area = Path().apply { addPath(line); lineTo(xy.last().x, size.height); lineTo(xy[0].x, size.height); close() }
        clipRect(right = size.width * draw + pad) {
            drawPath(area, Brush.verticalGradient(listOf(color.copy(alpha = 0.32f), color.copy(alpha = 0f))))
            drawPath(line, color, style = Stroke(2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
        if (draw > 0.95f) drawCircle(color, 3.5.dp.toPx(), xy.last())
    }
}

/** A half-ring gauge, [fraction] 0..1 (capped); the arc sweeps to its value. [label] sits inside the ring (e.g. "86 of 113"). */
@Composable
fun ArcGauge(fraction: Float, color: Color, contentDescription: String, modifier: Modifier = Modifier, label: String? = null) {
    val c = Lp.colors
    val f = fraction.coerceIn(0f, 1f)
    val grow = rememberGrow(f, delayMs = 150)
    val measurer = rememberTextMeasurer()
    Canvas(modifier.fillMaxWidth().height(70.dp).clearAndSetSemantics { this.contentDescription = contentDescription }) {
        val stroke = 10.dp.toPx()
        val d = min(size.width, size.height * 2) - stroke
        val tl = Offset((size.width - d) / 2, stroke / 2)
        drawArc(c.surf3, 180f, 180f, false, tl, Size(d, d), style = Stroke(stroke, cap = StrokeCap.Round))
        drawArc(Brush.horizontalGradient(listOf(lerp(color, c.info, 0.35f), color), startX = tl.x, endX = tl.x + d), 180f, 180f * f * grow, false, tl, Size(d, d), style = Stroke(stroke, cap = StrokeCap.Round))
        if (label != null) {
            val t = measurer.measure(label, chartStyle(c.soft, 12.sp, false), maxLines = 1)
            drawText(t, topLeft = Offset(size.width / 2 - t.size.width / 2f, tl.y + d / 2 - t.size.height))
        }
    }
}

/**
 * The trend chart (Trends week / month / year): the current period as a line with a soft fill, the previous period dashed behind
 * it, axis labels under it. Drag across to read a point: a cross line, a dot and a bubble with [scrubLabel] (value and date).
 * [current] may be shorter than [previous] (a period in progress). Both share one scale.
 */
@Composable
fun TrendChart(
    current: List<Double>,
    previous: List<Double>?,
    axis: List<String>,
    contentDescription: String,
    scrubLabel: (Int) -> String,
    modifier: Modifier = Modifier,
    plotHeight: Dp = 150.dp,
    slots: Int = maxOf(current.size, previous?.size ?: 0),
) {
    val c = Lp.colors
    val measurer = rememberTextMeasurer()
    val draw = rememberGrow(current, spec = tween(1300, easing = FastOutSlowInEasing))
    val pulse = rememberPulse()
    val haptics = rememberHaptics()
    var scrub by remember { mutableStateOf<Int?>(null) }
    val lh = labelHeight(12.sp)
    val bubble = 34.dp
    Canvas(
        modifier.fillMaxWidth().height(bubble + plotHeight + 8.dp + lh)
            .clearAndSetSemantics { this.contentDescription = contentDescription }
            .pointerInput(current, slots) {
                fun idx(x: Float): Int = ((x / size.width) * (slots - 1)).roundToInt().coerceIn(0, current.lastIndex)
                detectDragGesturesAfterLongPressOrTap(
                    onStart = { x -> val i = idx(x); if (i != scrub) haptics.tick(); scrub = i },
                    onMove = { x -> val i = idx(x); if (i != scrub) haptics.tick(); scrub = i },
                    onEnd = { scrub = null },
                )
            },
    ) {
        if (current.isEmpty() || slots < 2) return@Canvas
        val top = bubble.toPx()
        val plotH = plotHeight.toPx()
        val hi = max(current.max(), previous?.maxOrNull() ?: 0.0) * 1.08
        val X = { i: Int -> i * size.width / (slots - 1) }
        val Y = { v: Double -> top + plotH - (v / (if (hi <= 0) 1.0 else hi)).toFloat() * plotH }
        (1..3).forEach { k -> drawLine(c.fg.copy(alpha = 0.05f), Offset(0f, top + plotH * k / 4), Offset(size.width, top + plotH * k / 4)) }
        previous?.takeIf { it.size > 1 }?.let { prev ->
            val p = Path().apply { moveTo(X(0), Y(prev[0])); prev.drop(1).forEachIndexed { i, v -> lineTo(X(i + 1), Y(v)) } }
            drawPath(p, c.soft.copy(alpha = 0.5f), style = Stroke(2.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 5.dp.toPx()))))
        }
        val m = current.lastIndex
        val line = Path().apply { moveTo(X(0), Y(current[0])); current.drop(1).forEachIndexed { i, v -> lineTo(X(i + 1), Y(v)) } }
        val area = Path().apply { addPath(line); lineTo(X(m), top + plotH); lineTo(X(0), top + plotH); close() }
        clipRect(right = X(m) * draw + 6.dp.toPx()) {
            drawPath(area, Brush.verticalGradient(listOf(c.barHi.copy(alpha = 0.42f), c.barHi.copy(alpha = 0f)), startY = top, endY = top + plotH))
            drawPath(line, Brush.horizontalGradient(listOf(c.lilac, c.peach)), style = Stroke(3.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
        val end = Offset(X(m), Y(current[m]))
        if (draw > 0.98f && scrub == null) {
            drawCircle(c.peach.copy(alpha = 0.3f * (1f - pulse)), 6.dp.toPx() * (1f + 1.6f * pulse), end)
            drawCircle(c.fg, 5.dp.toPx(), end)
            drawCircle(c.peach, 5.dp.toPx(), end, style = Stroke(2.5.dp.toPx()))
        }
        scrub?.let { i ->
            val p = Offset(X(i), Y(current[i]))
            drawLine(c.fg.copy(alpha = 0.4f), Offset(p.x, top), Offset(p.x, top + plotH))
            drawCircle(c.fg, 5.dp.toPx(), p)
            val t = measurer.measure(scrubLabel(i), chartStyle(c.page, 14.sp, true).copy(fontFamily = LpDisplay), maxLines = 1)
            val w = t.size.width + 20.dp.toPx(); val h = t.size.height + 10.dp.toPx()
            val bx = (p.x - w / 2).coerceIn(0f, size.width - w)
            drawRoundRect(c.fg, Offset(bx, 0f), Size(w, h), CornerRadius(10.dp.toPx()))
            drawText(t, topLeft = Offset(bx + 10.dp.toPx(), 5.dp.toPx()))
        }
        val ly = top + plotH + 8.dp.toPx()
        val st = chartStyle(c.soft, 12.sp, false)
        axis.forEachIndexed { k, label ->
            val r = measurer.measure(label, st, maxLines = 1)
            val x = when (k) { 0 -> 0f; axis.lastIndex -> size.width - r.size.width; else -> size.width * k / axis.lastIndex - r.size.width / 2f }
            drawText(r, topLeft = Offset(x, ly))
        }
    }
}

/** Tap or drag reports x positions; ends on lift. Vertical scrolling is left to the parent. */
private suspend fun androidx.compose.ui.input.pointer.PointerInputScope.detectDragGesturesAfterLongPressOrTap(onStart: (Float) -> Unit, onMove: (Float) -> Unit, onEnd: () -> Unit) {
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false)
        onStart(down.position.x)
        while (true) {
            val e = awaitPointerEvent()
            val ch = e.changes.firstOrNull { it.id == down.id } ?: break
            if (!ch.pressed) break
            val dx = ch.position.x - ch.previousPosition.x
            val dy = ch.position.y - ch.previousPosition.y
            if (kotlin.math.abs(dx) >= kotlin.math.abs(dy)) ch.consume()
            onMove(ch.position.x)
        }
        onEnd()
    }
}
