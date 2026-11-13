package dev.aethernet.linkpearl.feature.onboarding

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** The Linkpearl mark (same shapes as the launcher icon): a pearl with a coral glow and a small highlight. Decorative. */
@Composable
fun PearlMark(modifier: Modifier = Modifier, size: Dp = 96.dp) {
    Canvas(modifier.size(size)) {
        val s = this.size.minDimension
        val c = Offset(s / 2, s / 2)
        drawCircle(Brush.radialGradient(listOf(Color(0x8CCD6771), Color(0x00CD6771)), center = c, radius = s * 0.5f), radius = s * 0.5f, center = c)
        val r = s * 0.32f
        val light = Offset(c.x - s * 0.07f, c.y - s * 0.07f)
        drawCircle(
            Brush.radialGradient(0f to Color(0xFFFFFAF0), 0.55f to Color(0xFFF6ECD9), 1f to Color(0xFFCDBFD9), center = light, radius = s * 0.45f),
            radius = r, center = c,
        )
        val h = Offset(c.x - s * 0.09f, c.y - s * 0.085f)
        rotate(-35f, h) {
            drawOval(Color(0xD9FFFFFF), topLeft = Offset(h.x - s * 0.052f, h.y - s * 0.031f), size = androidx.compose.ui.geometry.Size(s * 0.104f, s * 0.063f))
        }
    }
}
