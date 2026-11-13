package dev.aethernet.linkpearl.core.design

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color

/**
 * Colour tokens, taken from the web app's CSS (admin-worker/src/m-app.css), which is the approved look.
 * Dark is primary (deep indigo, cream, coral); light is white with the purple #8223d2 accent.
 * Semantic colours (good/warn/info/lilac/teal) always travel with words or icons: colour is never the only signal.
 */
@Immutable
data class LpColors(
    val isDark: Boolean,
    val page: Color,
    val surf: Color,
    val surf2: Color,
    val surf3: Color,
    val fg: Color,
    val soft: Color,
    val line: Color,
    val outline: Color,
    val acc: Color,
    val onAcc: Color,
    val accSoft: Color,
    val onAccSoft: Color,
    val accText: Color,
    val good: Color,
    val warn: Color,
    val info: Color,
    val lilac: Color,
    val teal: Color,
    val goodBg: Color,
    val warnBg: Color,
    val infoBg: Color,
    val lilacBg: Color,
    val tealBg: Color,
    /** Inactive bar fill and the highlighted (today) bar fill in charts. */
    val bar: Color,
    val barHi: Color,
    val shade: Color,
    /** Navigation bar / rail background. */
    val navBg: Color,
)

val DarkLpColors = LpColors(
    isDark = true,
    page = Color(0xFF1B0F41), surf = Color(0xFF2A1E4C), surf2 = Color(0xFF352A53), surf3 = Color(0xFF40355B),
    fg = Color(0xFFF6ECD9), soft = Color(0xFFB0A5A8), line = Color(0xFF3A2E56), outline = Color(0xFF776C81),
    acc = Color(0xFFCD6771), onAcc = Color(0xFF0C0E11), accSoft = Color(0xFF4D284E), onAccSoft = Color(0xFFDE9CA3), accText = Color(0xFFDC959C),
    good = Color(0xFF86D9A3), warn = Color(0xFFF0C36B), info = Color(0xFF9BBCFF), lilac = Color(0xFFC1ADFF), teal = Color(0xFF7FD8D3),
    goodBg = Color(0xFF393C5A), warnBg = Color(0xFF4A3851), infoBg = Color(0xFF3C3769), lilacBg = Color(0xFF423569), tealBg = Color(0xFF383C62),
    bar = Color(0xFF40355B), barHi = Color(0xFFCD6771), shade = Color(0x99000000), navBg = Color(0xFF140B31),
)

val LightLpColors = LpColors(
    isDark = false,
    page = Color(0xFFF4F4F4), surf = Color(0xFFFFFFFF), surf2 = Color(0xFFF6F6F6), surf3 = Color(0xFFEDEDED),
    fg = Color(0xFF1A1C1E), soft = Color(0xFF636566), line = Color(0xFFE4E4E4), outline = Color(0xFF85868A),
    acc = Color(0xFF8223D2), onAcc = Color(0xFFFFFFFF), accSoft = Color(0xFFF0E5FA), onAccSoft = Color(0xFF541788), accText = Color(0xFF8223D2),
    good = Color(0xFF16703D), warn = Color(0xFF8A5800), info = Color(0xFF1D5BBF), lilac = Color(0xFF6A3CC2), teal = Color(0xFF00716B),
    goodBg = Color(0xFFE8F1EC), warnBg = Color(0xFFF3EEE6), infoBg = Color(0xFFE8EFF9), lilacBg = Color(0xFFF0ECF9), tealBg = Color(0xFFE6F1F0),
    bar = Color(0xFFD9D4DE), barHi = Color(0xFF8223D2), shade = Color(0x66000000), navBg = Color(0xFFFFFFFF),
)
