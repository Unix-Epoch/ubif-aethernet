package dev.aethernet.linkpearl.core.design

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color

/**
 * Colour tokens, taken from the web app's CSS (admin-worker/src/m-app.css), which is the approved look.
 * Dark is primary (deep indigo, cream, coral); light is white with the purple #8223d2 accent.

 * Nov 2026 refresh: cards get a quiet gradient, a light top edge and a soft shadow instead of a border; one hero card per screen
 * gets a gradient with slow drifting glows. Light keeps white surfaces and the purple accent (a lavender wash on the page).
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
    /** Red: Incomplete. */
    val bad: Color,
    val badBg: Color,
    /** Inactive bar fill and the highlighted (today) bar fill in charts. */
    val bar: Color,
    val barHi: Color,
    val shade: Color,
    /** Navigation bar / rail background. */
    val navBg: Color,
    // ---- refresh (Nov 2026): depth, glow and the pearl ("nacre") look ----
    /** Card fill, top to bottom (a quiet vertical gradient instead of a flat fill and border). */
    val cardTop: Color,
    val cardBottom: Color,
    /** The 1dp light catch along a card's top edge, fading out downward. */
    val edge: Color,
    /** Soft drop shadow under cards and the floating nav. */
    val shadow: Color,
    /** Hero card base gradient (the one card per screen that carries the figure that matters most). */
    val heroA: Color,
    val heroB: Color,
    val heroC: Color,
    /** The drifting glows over the hero card (coral, lilac, teal) and the light sweep after a refresh. */
    val glowWarm: Color,
    val glowCool: Color,
    val glowTeal: Color,
    val sheen: Color,
    /** Light top of the highlighted bar / end of the chart line gradient. */
    val peach: Color,
    /** Faint wash behind the page, top right and left. */
    val washA: Color,
    val washB: Color,
    /** Floating nav glass and its selected pill. */
    val navGlass: Color,
    val navPillA: Color,
    val navPillB: Color,
    val onNavPill: Color,
    /** Glass fill for controls that sit on the page (search, store pill, filters). */
    val glass: Color,
)

val DarkLpColors = LpColors(
    isDark = true,
    page = Color(0xFF1B0F41), surf = Color(0xFF2A1E4C), surf2 = Color(0xFF352A53), surf3 = Color(0xFF40355B),
    fg = Color(0xFFF6ECD9), soft = Color(0xFFB0A5A8), line = Color(0xFF3A2E56), outline = Color(0xFF776C81),
    acc = Color(0xFFCD6771), onAcc = Color(0xFF0C0E11), accSoft = Color(0xFF4D284E), onAccSoft = Color(0xFFDE9CA3), accText = Color(0xFFDC959C),
    good = Color(0xFF86D9A3), warn = Color(0xFFF0C36B), info = Color(0xFF9BBCFF), lilac = Color(0xFFC1ADFF), teal = Color(0xFF7FD8D3),
    goodBg = Color(0xFF393C5A), warnBg = Color(0xFF4A3851), infoBg = Color(0xFF3C3769), lilacBg = Color(0xFF423569), tealBg = Color(0xFF383C62),
    bad = Color(0xFFFF8A80), badBg = Color(0xFF552238),
    bar = Color(0xFF40355B), barHi = Color(0xFFCD6771), shade = Color(0x99000000), navBg = Color(0xFF140B31),
    cardTop = Color(0xFF2E2253), cardBottom = Color(0xFF281C49), edge = Color(0x14FFFFFF), shadow = Color(0x8C050014),
    heroA = Color(0xFF3C2468), heroB = Color(0xFF2B1D52), heroC = Color(0xFF4A2552),
    glowWarm = Color(0x61CD6771), glowCool = Color(0x40C1ADFF), glowTeal = Color(0x2E7FD8D3), sheen = Color(0x29FFFAF0),
    peach = Color(0xFFF2A58A), washA = Color(0xFF4B2158), washB = Color(0xFF261B60),
    navGlass = Color(0xF2140B31), navPillA = Color(0xFF5C2D5A), navPillB = Color(0xFF40296A), onNavPill = Color(0xFFF6ECD9),
    glass = Color(0x0FFFFFFF),
)

val LightLpColors = LpColors(
    isDark = false,
    page = Color(0xFFF5F3F9), surf = Color(0xFFFFFFFF), surf2 = Color(0xFFF6F6F6), surf3 = Color(0xFFEDEDED),
    fg = Color(0xFF1A1C1E), soft = Color(0xFF636566), line = Color(0xFFE4E4E4), outline = Color(0xFF85868A),
    acc = Color(0xFF8223D2), onAcc = Color(0xFFFFFFFF), accSoft = Color(0xFFF0E5FA), onAccSoft = Color(0xFF541788), accText = Color(0xFF8223D2),
    good = Color(0xFF16703D), warn = Color(0xFF8A5800), info = Color(0xFF1D5BBF), lilac = Color(0xFF6A3CC2), teal = Color(0xFF00716B),
    goodBg = Color(0xFFE8F1EC), warnBg = Color(0xFFF3EEE6), infoBg = Color(0xFFE8EFF9), lilacBg = Color(0xFFF0ECF9), tealBg = Color(0xFFE6F1F0),
    bad = Color(0xFFB3261E), badBg = Color(0xFFFBEAE9),
    bar = Color(0xFFD9D4DE), barHi = Color(0xFF8223D2), shade = Color(0x66000000), navBg = Color(0xFFFFFFFF),
    cardTop = Color(0xFFFFFFFF), cardBottom = Color(0xFFFCFBFE), edge = Color(0xFFFFFFFF), shadow = Color(0x262A1452),
    heroA = Color(0xFFF1E6FD), heroB = Color(0xFFFFFFFF), heroC = Color(0xFFFCE9EC),
    glowWarm = Color(0x40E87A86), glowCool = Color(0x388223D2), glowTeal = Color(0x2600A39A), sheen = Color(0x80FFFFFF),
    peach = Color(0xFFB66BF0), washA = Color(0xFFEDE3FA), washB = Color(0xFFF8EEF3),
    navGlass = Color(0xF7FFFFFF), navPillA = Color(0xFF8E35DA), navPillB = Color(0xFF6A1FB0), onNavPill = Color(0xFFFFFFFF),
    glass = Color(0xFFFFFFFF),
)
