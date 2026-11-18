package dev.aethernet.linkpearl.feature.scanner.screenshot

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.nav.LpNavScaffold
import dev.aethernet.linkpearl.core.nav.TopLevel
import dev.aethernet.linkpearl.feature.scanner.ScanArea
import dev.aethernet.linkpearl.feature.scanner.ScanKind
import dev.aethernet.linkpearl.feature.scanner.ScanTuning
import dev.aethernet.linkpearl.feature.scanner.ScannerScreen
import dev.aethernet.linkpearl.feature.scanner.ScannerUi
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.shoot
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.ParameterizedRobolectricTestRunner.Parameters
import androidx.compose.ui.unit.dp

enum class ScannerShot(val file: String, val ui: ScannerUi) {
    Labels("labels", ScannerUi(ScanKind.Labels, ScanTuning.default(ScanKind.Labels))),
    Reading("labels-reading", ScannerUi(ScanKind.Labels, ScanTuning.default(ScanKind.Labels).copy(zoom = 1.6f, hold = 2, vibrate = true), "900101-0000000409", 12)),
    Qr("qr", ScannerUi(ScanKind.Qr, ScanTuning.default(ScanKind.Qr).copy(light = true), "AER-1047-K", 3)),
}

/** Settings > Scanner at phone size, dark and light; the viewfinder is a plain box with the scan area drawn. Output `scanner/<device>-<name>-<dark|light>.png`. */
@RunWith(ParameterizedRobolectricTestRunner::class)
class ScannerScreenshotTest(private val shot: ScannerShot, private val device: Device, private val dark: Boolean) {
    @get:Rule val rule = createComposeRule()

    companion object {
        @JvmStatic
        @Parameters(name = "{0} {1} dark={2}")
        fun params(): List<Array<Any>> = buildList { for (dark in listOf(true, false)) ScannerShot.entries.forEach { add(arrayOf(it, Device.Phone, dark)) } }
    }

    @Test fun render() {
        rule.shoot("scanner", shot.file, device, dark) {
            LpNavScaffold(selected = TopLevel.Settings, onSelect = {}) {
                ScannerScreen(shot.ui, camera = { t, _, _ -> FakeViewfinder(t.area, shot.ui.lastCode != null) })
            }
        }
    }
}

@androidx.compose.runtime.Composable
private fun FakeViewfinder(a: ScanArea, reading: Boolean) {
    BoxWithConstraints(Modifier.fillMaxSize().background(Lp.colors.surf3)) {
        val color = if (reading) Lp.colors.good else Lp.colors.fg
        Box(Modifier.offset(maxWidth * a.left, maxHeight * a.top).size(maxWidth * (a.right - a.left), maxHeight * (a.bottom - a.top)).border(2.dp, color, LpShapes.Card))
        Box(Modifier.offset(maxWidth * a.left - 7.dp, maxHeight * a.top - 7.dp).size(14.dp).background(color, androidx.compose.foundation.shape.CircleShape))
        Box(Modifier.offset(maxWidth * a.right - 7.dp, maxHeight * a.bottom - 7.dp).size(14.dp).background(color, androidx.compose.foundation.shape.CircleShape))
    }
}
