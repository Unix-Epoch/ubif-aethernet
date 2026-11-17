package dev.aethernet.linkpearl.core.design

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/** Every style uses tabular numerals ("tnum") so figures line up and do not jitter when they change. */
private const val TNUM = "tnum"

/** Space Grotesk (SIL OFL 1.1, android/third-party-SpaceGrotesk-OFL.txt): the figures and screen titles. Body text stays Roboto. */
val LpDisplay = FontFamily(
    Font(dev.aethernet.linkpearl.R.font.space_grotesk_medium, FontWeight.Medium),
    Font(dev.aethernet.linkpearl.R.font.space_grotesk_semibold, FontWeight.SemiBold),
    Font(dev.aethernet.linkpearl.R.font.space_grotesk_bold, FontWeight.Bold),
)

private fun style(size: Int, weight: FontWeight = FontWeight.Normal, lineHeight: Int = (size * 1.3f).toInt(), tracking: Float = 0f, family: FontFamily = FontFamily.Default) = TextStyle(
    fontFamily = family,
    fontSize = size.sp,
    lineHeight = lineHeight.sp,
    fontWeight = weight,
    letterSpacing = tracking.sp,
    fontFeatureSettings = TNUM,
)

/** Named text styles used by the shared composables (mirrors the web app's sizes). Use these, not raw sp values. */
object LpType {
    /** The hero figure (today's sales on Home, the Trends total). */
    val Hero = style(56, FontWeight.Bold, 62, -1.5f, LpDisplay)
    val Big = style(44, FontWeight.Bold, 50, -1f, LpDisplay)
    val BigCompact = style(38, FontWeight.Bold, 44, -1f, LpDisplay)
    val Value = style(28, FontWeight.Bold, 34, -0.5f, LpDisplay)
    val ValueMedium = style(20, FontWeight.Bold, 26, -0.2f, LpDisplay)
    /** Screen titles ("Work orders", "Alerts"). */
    val Screen = style(27, FontWeight.Bold, 34, -0.6f, LpDisplay)
    val Title = style(22, FontWeight.SemiBold, 28, -0.3f, LpDisplay)
    /** A work order or sales order number on a card. */
    val Number = style(21, FontWeight.Bold, 26, -0.3f, LpDisplay)
    val Switcher = style(17, FontWeight.SemiBold, 22)
    val Body = style(16, FontWeight.Normal, 22)
    val BodyStrong = style(16, FontWeight.SemiBold, 22)
    val Row = style(18, FontWeight.Normal, 24)
    val Small = style(15, FontWeight.Normal, 20)
    val Label = style(14, FontWeight.SemiBold, 20, 0.2f)
    val Chip = style(14, FontWeight.SemiBold, 20)
    val Caption = style(14, FontWeight.Normal, 18)
}

val LpMaterialTypography = Typography(
    displayLarge = LpType.Big, displayMedium = LpType.Big, displaySmall = LpType.Value,
    headlineLarge = LpType.Value, headlineMedium = LpType.Title, headlineSmall = LpType.Title,
    titleLarge = LpType.Title, titleMedium = LpType.Switcher, titleSmall = LpType.BodyStrong,
    bodyLarge = LpType.Body, bodyMedium = LpType.Small, bodySmall = LpType.Caption,
    labelLarge = LpType.BodyStrong, labelMedium = LpType.Chip, labelSmall = LpType.Caption,
)
