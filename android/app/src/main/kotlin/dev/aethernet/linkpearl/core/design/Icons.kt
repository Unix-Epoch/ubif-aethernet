package dev.aethernet.linkpearl.core.design

import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The icon set: 24-unit outline icons, 2-unit round strokes (the web app's style), defined from SVG path data so no icon library is
 * needed. Every feature's icons live here, once. Tinted by the surrounding content colour.
 */
object LpIcons {
    private fun icon(name: String, vararg paths: String): ImageVector {
        val b = ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
        paths.forEach { d ->
            b.addPath(
                pathData = PathParser().parsePathString(d).toNodes(),
                fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round,
            )
        }
        return b.build()
    }

    val Store = icon("store", "M4 9l1-5h14l1 5M4 9v11h16V9M4 9a3 3 0 0 0 5 0 3 3 0 0 0 6 0 3 3 0 0 0 5 0")
    val ChevronDown = icon("chevronDown", "M6 9l6 6 6-6")
    val ChevronRight = icon("chevronRight", "M9 5l7 7-7 7")
    val Refresh = icon("refresh", "M20 4v6h-6M4 20v-6h6", "M19 10a8 8 0 0 0-14-3M5 14a8 8 0 0 0 14 3")
    val Clock = icon("clock", "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0", "M12 7v5l3 2")
    val Check = icon("check", "M5 12.5l5 5L19 7")
    val TrendUp = icon("trendUp", "M4 16l6-6 4 4 6-7")
    val TrendDown = icon("trendDown", "M4 8l6 6 4-4 6 7")
    val WifiOff = icon("wifiOff", "M2 9a15 15 0 0 1 5-3M22 9a15 15 0 0 0-6-3.5M5 13a10 10 0 0 1 3-2M19 13a10 10 0 0 0-4-2.6M9 17a5 5 0 0 1 6 0", "M3 3l18 18")
    val Home = icon("home", "M3 11l9-8 9 8M5 10v10h14V10M10 20v-6h4v6")
    val Bell = icon("bell", "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0")
    val Orders = icon("orders", "M9 4h6v3H9zM7 5.5H5v15h14v-15h-2", "M8.5 12h7M8.5 16h5")
    val Sliders = icon("sliders", "M4 7h10M18 7h2M4 17h2M10 17h10", "M14 7a2 2 0 1 0 4 0a2 2 0 1 0-4 0", "M6 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0")
    val Lock = icon("lock", "M6 11h12v9H6z", "M8.5 11V8a3.5 3.5 0 0 1 7 0v3")
    val Unlock = icon("unlock", "M6 11h12v9H6z", "M8.5 11V8a3.5 3.5 0 0 1 6.5-1.8")
    val Search = icon("search", "M4 11a7 7 0 1 0 14 0a7 7 0 1 0-14 0", "M16 16l4.5 4.5")
    val Back = icon("back", "M20 12H5M11 6l-6 6 6 6")
    val Close = icon("close", "M6 6l12 12M18 6L6 18")
    val Plus = icon("plus", "M12 5v14M5 12h14")
    val Minus = icon("minus", "M5 12h14")
    val Phone = icon("phone", "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2")
    val Message = icon("message", "M4 5h16v11H9l-5 4z")
    val Edit = icon("edit", "M4 20l1-4L16 5l3 3L8 19zM14 7l3 3")
    val Warning = icon("warning", "M12 4l9 16H3z", "M12 10v4M12 17v.01")
    val Hourglass = icon("hourglass", "M7 3h10M7 21h10M8 3v4l4 5-4 5v4M16 3v4l-4 5 4 5v4")
    val External = icon("external", "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6")
    val Person = icon("person", "M8 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0", "M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1")
    val Eye = icon("eye", "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z", "M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0")
    val EyeOff = icon("eyeOff", "M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.6 3.5M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6", "M3 3l18 18", "M9.9 9.9a3 3 0 0 0 4.2 4.2")
    val Mail = icon("mail", "M3 6h18v12H3z", "M3 7l9 6 9-6")
    val Auto = icon("auto", "M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1")
    val Calendar = icon("calendar", "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4")
    val Package = icon("package", "M12 3l8 4.5v9L12 21l-8-4.5v-9z", "M4 7.5l8 4.5 8-4.5M12 12v9")
    /** Retrace: two stops joined by a winding trail. */
    val Retrace = icon("retrace", "M5 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0", "M15 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0", "M9 6h5a3 3 0 0 1 0 6h-4a3 3 0 0 0 0 6h5")
    val Outbox = icon("outbox", "M4 14v6h16v-6M12 15V4M8 8l4-4 4 4")
    val BellOff = icon("bellOff", "M6 8a6 6 0 0 1 9.5-4.9M18 11c0 5 3 6 3 6H8M10.3 21a1.94 1.94 0 0 0 3.4 0", "M3 3l18 18")
}

/** An icon with a content description (or `null` when the surrounding control already says what it is: then it is hidden from TalkBack). */
@Composable
fun LpIcon(icon: ImageVector, contentDescription: String?, modifier: Modifier = Modifier, size: Dp = 24.dp, tint: Color = LocalContentColor.current) {
    Icon(
        imageVector = icon, contentDescription = contentDescription,
        modifier = modifier.size(size).let { if (contentDescription == null) it.clearAndSetSemantics { } else it },
        tint = tint,
    )
}
