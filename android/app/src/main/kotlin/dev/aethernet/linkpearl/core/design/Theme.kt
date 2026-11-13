package dev.aethernet.linkpearl.core.design

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf

val LocalLpColors = staticCompositionLocalOf { DarkLpColors }

/** `Lp.colors.surf`, etc. */
object Lp {
    val colors: LpColors @Composable @ReadOnlyComposable get() = LocalLpColors.current
}

private fun LpColors.toMaterial(): ColorScheme {
    val base = if (isDark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = acc, onPrimary = onAcc, primaryContainer = accSoft, onPrimaryContainer = onAccSoft,
        secondary = acc, onSecondary = onAcc, secondaryContainer = accSoft, onSecondaryContainer = onAccSoft,
        tertiary = teal, background = page, onBackground = fg,
        surface = surf, onSurface = fg, surfaceVariant = surf3, onSurfaceVariant = soft,
        surfaceContainer = surf, surfaceContainerLow = surf, surfaceContainerLowest = page,
        surfaceContainerHigh = surf2, surfaceContainerHighest = surf3,
        outline = outline, outlineVariant = line, error = warn, onError = onAcc,
        scrim = shade,
    )
}

/** Follows the system light/dark setting unless [darkTheme] is given (tests do). */
@Composable
fun LinkpearlTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val colors = if (darkTheme) DarkLpColors else LightLpColors
    CompositionLocalProvider(LocalLpColors provides colors) {
        MaterialTheme(colorScheme = colors.toMaterial(), typography = LpMaterialTypography, shapes = LpMaterialShapes, content = content)
    }
}
