package dev.aethernet.linkpearl.feature.workorders

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

/** Icons Work orders needs that core/design does not have yet (same 24-unit outline style). Requested for LpIcons in the report. */
object WoIcons {
    private fun icon(name: String, vararg paths: String): ImageVector {
        val b = ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
        paths.forEach { d ->
            b.addPath(PathParser().parsePathString(d).toNodes(), fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = 2f, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round)
        }
        return b.build()
    }

    val Person = icon("person", "M8 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0", "M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1")
    val Eye = icon("eye", "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z", "M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0")
    val EyeOff = icon("eyeOff", "M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.6 3.5M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6", "M3 3l18 18", "M9.9 9.9a3 3 0 0 0 4.2 4.2")
    val Mail = icon("mail", "M3 6h18v12H3z", "M3 7l9 6 9-6")
    val Auto = icon("auto", "M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1")
}
