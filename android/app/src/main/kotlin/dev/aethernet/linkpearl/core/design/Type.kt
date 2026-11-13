package dev.aethernet.linkpearl.core.design

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/** Every style uses tabular numerals ("tnum") so figures line up and do not jitter when they change. */
private const val TNUM = "tnum"

private fun style(size: Int, weight: FontWeight = FontWeight.Normal, lineHeight: Int = (size * 1.3f).toInt(), tracking: Float = 0f) = TextStyle(
    fontFamily = FontFamily.Default,
    fontSize = size.sp,
    lineHeight = lineHeight.sp,
    fontWeight = weight,
    letterSpacing = tracking.sp,
    fontFeatureSettings = TNUM,
)

/** Named text styles used by the shared composables (mirrors the web app's sizes). Use these, not raw sp values. */
object LpType {
    val Big = style(44, FontWeight.Bold, 48, -0.5f)
    val BigCompact = style(38, FontWeight.Bold, 42, -0.5f)
    val Value = style(28, FontWeight.Bold, 32)
    val ValueMedium = style(20, FontWeight.Bold, 26)
    val Title = style(22, FontWeight.SemiBold, 28)
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
