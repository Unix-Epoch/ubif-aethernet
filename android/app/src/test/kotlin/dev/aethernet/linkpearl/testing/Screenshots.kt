package dev.aethernet.linkpearl.testing

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.adaptive.HingeInfo
import androidx.compose.material3.adaptive.Posture
import androidx.compose.material3.adaptive.WindowAdaptiveInfo
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ProvidedValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.window.core.layout.WindowSizeClass
import androidx.window.core.layout.computeWindowSizeClass
import com.github.takahirom.roborazzi.captureRoboImage
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LinkpearlTheme
import dev.aethernet.linkpearl.core.nav.AdaptiveProvider
import org.robolectric.RuntimeEnvironment
import java.io.File

/**
 * Shared screenshot harness (scaffold-owned). Renders a composable on the JVM at a device size, in dark or light, optionally with a
 * simulated fold, and writes `android/screenshots/<feature>/<device>-<name>-<dark|light>.png` (only when run through
 * `./gradlew recordRoborazziDebug`, i.e. the `screenshots` task; a plain `./gradlew test` just exercises the composition).
 *
 * Fold simulation: the fold is injected as a fake `WindowAdaptiveInfo` whose Posture carries a vertical HingeInfo, so layout code
 * takes exactly the path it takes with a real WindowManager FoldingFeature. [Device.Inner] uses a flat (zero-width) vertical fold in
 * the middle; what a real Galaxy Z Fold reports (exact bounds, occlusion, state changes) can only be confirmed on the phone.
 */
enum class Device(val key: String, val widthDp: Int, val heightDp: Int, val foldXDp: Float? = null) {
    Phone("phone", 412, 915),
    /** A phone-width screen tall enough to see all of Home at once (for review; the real phone scrolls). */
    PhoneTall("phone-tall", 412, 1500),
    /** Galaxy Z Fold cover screen (sizes derived in the mockup notes). */
    Cover("cover", 412, 960),
    /** Galaxy Z Fold inner screen with a vertical fold down the middle. */
    Inner("inner", 859, 954, foldXDp = 429.5f),
    /** Inner screen without any fold information (the generic wide fallback). */
    InnerNoFold("inner-nofold", 859, 954),
}

private const val DENSITY = 2f // xhdpi

/**
 * With [tabletop] the device is half-opened and held like a laptop: a separating horizontal fold across the middle (what a real Fold
 * reports in that posture is only confirmed on the phone). Otherwise the fold, if the device has one, is the vertical one.
 */
fun adaptiveInfoFor(device: Device, tabletop: Boolean = false): WindowAdaptiveInfo {
    val size = WindowSizeClass.BREAKPOINTS_V1.computeWindowSizeClass(device.widthDp.toFloat(), device.heightDp.toFloat())
    if (tabletop) {
        val y = device.heightDp / 2f * DENSITY
        val fold = HingeInfo(Rect(0f, y, device.widthDp * DENSITY, y), isFlat = false, isVertical = false, isSeparating = true, isOccluding = false)
        return WindowAdaptiveInfo(size, Posture(isTabletop = true, hingeList = listOf(fold)))
    }
    val hinges = device.foldXDp?.let { x ->
        val px = x * DENSITY
        listOf(HingeInfo(Rect(px, 0f, px, device.heightDp * DENSITY), isFlat = true, isVertical = true, isSeparating = false, isOccluding = false))
    } ?: emptyList()
    return WindowAdaptiveInfo(size, Posture(isTabletop = tabletop, hingeList = hinges))
}

private val screenshotDir: File by lazy { File(System.getProperty("linkpearl.screenshotDir") ?: "build/screenshots") }

/** Renders [content] inside the app theme and an [AdaptiveProvider] for [device]; writes the PNG. */
fun ComposeContentTestRule.shoot(
    feature: String,
    name: String,
    device: Device,
    dark: Boolean,
    fontScale: Float = 1f,
    tabletop: Boolean = false,
    /** Extra composition locals for the content (a fixed clock, say). */
    providers: Array<ProvidedValue<*>> = emptyArray(),
    content: @Composable () -> Unit,
) {
    RuntimeEnvironment.setQualifiers("w${device.widthDp}dp-h${device.heightDp}dp-xhdpi")
    setContent {
        CompositionLocalProvider(LocalDensity provides Density(DENSITY, fontScale), *providers) {
            LinkpearlTheme(darkTheme = dark) {
                AdaptiveProvider(adaptiveInfoFor(device, tabletop)) {
                    Box(Modifier.size(device.widthDp.dp, device.heightDp.dp).background(Lp.colors.page)) { content() }
                }
            }
        }
    }
    waitForIdle()
    val file = File(screenshotDir, "$feature/${device.key}${if (tabletop) "-tabletop" else ""}-$name-${if (dark) "dark" else "light"}.png")
    file.parentFile?.mkdirs()
    onRoot().captureRoboImage(file.path)
}
