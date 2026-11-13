package dev.aethernet.linkpearl.core.design

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.ui.unit.dp

/** Spacing scale and shapes. The 48dp minimum touch target is `LpSpacing.Touch`. */
object LpSpacing {
    val Xs = 4.dp
    val S = 8.dp
    val M = 12.dp
    val L = 16.dp
    val Xl = 24.dp
    val Touch = 48.dp
    /** Screen side padding on phones. */
    val Gutter = 16.dp
    /** Minimum gap between two panes (the hinge replaces it when the fold is wider). */
    val PaneGutter = 32.dp
}

object LpShapes {
    val Card = RoundedCornerShape(20.dp)
    val Notice = RoundedCornerShape(16.dp)
    val Pill = RoundedCornerShape(50)
    val Sheet = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
    val Row = RoundedCornerShape(16.dp)
}

val LpMaterialShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp), small = RoundedCornerShape(12.dp), medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(20.dp), extraLarge = RoundedCornerShape(28.dp),
)
