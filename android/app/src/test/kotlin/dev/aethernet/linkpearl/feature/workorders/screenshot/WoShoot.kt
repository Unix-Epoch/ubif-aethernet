package dev.aethernet.linkpearl.feature.workorders.screenshot

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.adaptive.HingeInfo
import androidx.compose.material3.adaptive.Posture
import androidx.compose.material3.adaptive.WindowAdaptiveInfo
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
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
import dev.aethernet.linkpearl.core.design.LinkpearlTheme
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.nav.AdaptiveProvider
import dev.aethernet.linkpearl.feature.workorders.LocalWoClock
import dev.aethernet.linkpearl.feature.workorders.WoClock
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.adaptiveInfoFor
import org.robolectric.RuntimeEnvironment
import java.io.File
import java.time.ZoneId

/**
 * Work orders' screenshot helper: the shared harness's look (same sizes, density, output folder and file names) plus a fixed clock
 * and the tabletop posture (a half-opened Fold held like a laptop: a horizontal fold across the middle), which the shared
 * `shoot()` does not simulate.
 */
fun ComposeContentTestRule.shootWo(name: String, device: Device, dark: Boolean, tabletop: Boolean = false, fontScale: Float = 1f, content: @Composable () -> Unit) {
    val density = 2f
    RuntimeEnvironment.setQualifiers("w${device.widthDp}dp-h${device.heightDp}dp-xhdpi")
    val info: WindowAdaptiveInfo = if (!tabletop) adaptiveInfoFor(device) else {
        val size = WindowSizeClass.BREAKPOINTS_V1.computeWindowSizeClass(device.widthDp.toFloat(), device.heightDp.toFloat())
        val y = device.heightDp / 2f * density
        WindowAdaptiveInfo(size, Posture(isTabletop = true, hingeList = listOf(HingeInfo(Rect(0f, y, device.widthDp * density, y), isFlat = false, isVertical = false, isSeparating = true, isOccluding = false))))
    }
    setContent {
        CompositionLocalProvider(LocalDensity provides Density(density, fontScale), LocalWoClock provides WoClock({ WoSamples.NOW }, ZoneId.of("America/New_York"), ticks = false)) {
            LinkpearlTheme(darkTheme = dark) {
                AdaptiveProvider(info) {
                    Box(Modifier.size(device.widthDp.dp, device.heightDp.dp).background(Lp.colors.page)) { content() }
                }
            }
        }
    }
    waitForIdle()
    val dir = File(System.getProperty("linkpearl.screenshotDir") ?: "build/screenshots")
    val suffix = (if (fontScale != 1f) "-font$fontScale" else "") + if (dark) "-dark" else "-light"
    val file = File(dir, "workorders/${device.key}${if (tabletop) "-tabletop" else ""}-$name$suffix.png")
    file.parentFile?.mkdirs()
    onRoot().captureRoboImage(file.path)
}
