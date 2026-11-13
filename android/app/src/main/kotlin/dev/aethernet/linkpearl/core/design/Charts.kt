package dev.aethernet.linkpearl.core.design

import androidx.compose.foundation.Canvas
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

/**
 * Seven (or n) bars over day letters. Highlights the last bar (today). A value of 0 draws a short stub, null draws nothing.
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
    val topPad = if (showValues) lh + 7.dp else 2.dp
    val total = topPad + plotHeight + 4.dp + lh + 4.dp
    Canvas(modifier.fillMaxWidth().height(total).semantics { this.contentDescription = contentDescription }.clearAndSetSemantics { this.contentDescription = contentDescription }) {
        val n = values.size
        if (n == 0) return@Canvas
        val barW = size.width / (n + (n - 1) * 0.4f)
        val gap = barW * 0.4f
        val maxV = max(max(cap ?: 0.0, 1.0), values.filterNotNull().maxOrNull() ?: 0.0)
        val plotH = plotHeight.toPx()
        val top = topPad.toPx()
        val stub = 3.dp.toPx()
        values.forEachIndexed { i, v ->
            val x = i * (barW + gap)
            val last = i == n - 1
            if (v != null) {
                val h = if (v > 0) max(stub, (v / maxV).toFloat() * plotH) else stub
                val y = top + plotH - h
                val color = if (last) c.barHi else if (v > 0) c.bar else c.bar.copy(alpha = 0.7f)
                drawRoundRect(color, Offset(x, y), Size(barW, h), CornerRadius(min(4.dp.toPx(), h / 2)))
                if (showValues && v > 0) {
                    val st = chartStyle(if (last) c.fg else c.soft, textSize, last)
                    val r = measurer.measure(valueFormat(v), st, maxLines = 1)
                    drawText(r, topLeft = Offset(x + barW / 2 - r.size.width / 2f, y - 5.dp.toPx() - r.size.height))
                }
            }
            if (i < days.size) centred(measurer, Fmt.dayLetter(days[i]), chartStyle(if (last) c.fg else c.soft, textSize, last), x + barW / 2, top + plotH + 4.dp.toPx())
        }
    }
}

/**
 * Line over the target band (dashed outline), one point per day, today's point highlighted. Gaps (null) break the line.
 * [target] is [low, high] in dollars.
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
    val total = topPad + plotHeight + 6.dp + lh + 4.dp
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
        // band
        val by0 = y(target[1].toDouble()); val by1 = y(target[0].toDouble())
        drawRect(c.surf3, Offset(0.5f, by0), Size(size.width - 1f, by1 - by0))
        drawRect(c.good, Offset(0.5f, by0), Size(size.width - 1f, by1 - by0), style = Stroke(1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 2.dp.toPx()))))
        // line
        val path = Path()
        values.forEachIndexed { i, v ->
            if (v == null) return@forEachIndexed
            if (i > 0 && values[i - 1] != null) path.lineTo(xs(i), y(v)) else path.moveTo(xs(i), y(v))
        }
        drawPath(path, c.fg, style = Stroke(2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
        // points and labels
        values.forEachIndexed { i, v ->
            if (v == null) return@forEachIndexed
            val last = i == n - 1
            val p = Offset(xs(i), y(v))
            if (last) drawCircle(c.barHi, pointRadius.toPx(), p)
            else {
                drawCircle(c.surf, pointRadius.toPx(), p)
                drawCircle(c.fg, pointRadius.toPx(), p, style = Stroke(1.5.dp.toPx()))
            }
            if (showValues) {
                val r = measurer.measure(Fmt.money(v), chartStyle(if (last) c.fg else c.soft, textSize, last), maxLines = 1)
                val x = (p.x - r.size.width / 2f).coerceIn(0f, size.width - r.size.width)
                drawText(r, topLeft = Offset(x, p.y - 10.dp.toPx() - r.size.height / 2f))
            }
        }
        values.indices.forEach { i ->
            if (i < days.size) centred(measurer, Fmt.dayLetter(days[i]), chartStyle(if (i == n - 1) c.fg else c.soft, textSize, i == n - 1), xs(i), top + plotH + 6.dp.toPx())
        }
    }
}

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
    Canvas(modifier.fillMaxWidth().height(36.dp + lh + 4.dp).clearAndSetSemantics { this.contentDescription = contentDescription }) {
        val w = size.width
        val x = { a: Double -> (((a.coerceIn(min.toDouble(), max.toDouble())) - min) / (max - min)).toFloat() * w }
        val trackY = 20.dp.toPx()
        drawRoundRect(c.surf3, Offset(0f, trackY), Size(w, 12.dp.toPx()), CornerRadius(6.dp.toPx()))
        val x0 = x(target[0].toDouble()); val x1 = x(target[1].toDouble())
        drawRoundRect(c.goodBg, Offset(x0, 17.dp.toPx()), Size(x1 - x0, 18.dp.toPx()), CornerRadius(6.dp.toPx()))
        drawRoundRect(c.good, Offset(x0, 17.dp.toPx()), Size(x1 - x0, 18.dp.toPx()), CornerRadius(6.dp.toPx()), style = Stroke(2.dp.toPx()))
        if (value != null) {
            val mx = x(value)
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

/** A segmented bar: one segment per positive count, widths proportional, 4dp gaps. */
@Composable
fun SegmentBar(segments: List<Pair<Color, Int>>, contentDescription: String, modifier: Modifier = Modifier) {
    val shown = segments.filter { it.second > 0 }
    Row(modifier.fillMaxWidth().height(14.dp).clearAndSetSemantics { this.contentDescription = contentDescription }, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        shown.forEach { (color, n) -> Box(Modifier.weight(n.toFloat()).fillMaxHeight().clip(RoundedCornerShape(7.dp)).background(color)) }
    }
}

/** Track with a filled part, [fraction] 0..1 (values above 1 are capped). Hidden from TalkBack unless [contentDescription] is given. */
@Composable
fun ProgressBar(fraction: Float, color: Color, modifier: Modifier = Modifier, contentDescription: String? = null) {
    val f = fraction.coerceIn(0f, 1f)
    Box(
        modifier.fillMaxWidth().height(14.dp).clip(RoundedCornerShape(7.dp)).background(Lp.colors.surf3)
            .let { if (contentDescription != null) it.semantics { this.contentDescription = contentDescription } else it.clearAndSetSemantics { } },
    ) {
        if (f > 0f) Box(Modifier.fillMaxHeight().fillMaxWidth(f).clip(RoundedCornerShape(7.dp)).background(color))
    }
}
