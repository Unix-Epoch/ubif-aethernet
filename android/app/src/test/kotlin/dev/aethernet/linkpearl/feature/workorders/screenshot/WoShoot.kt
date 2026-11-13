package dev.aethernet.linkpearl.feature.workorders.screenshot

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import dev.aethernet.linkpearl.feature.workorders.LocalWoClock
import dev.aethernet.linkpearl.feature.workorders.WoClock
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.shoot
import java.time.ZoneId

/** Work orders' shots: the shared harness plus a fixed clock. Output: `workorders/<device>[-tabletop]-<name>[-font1.3]-<dark|light>.png`. */
fun ComposeContentTestRule.shootWo(name: String, device: Device, dark: Boolean, tabletop: Boolean = false, fontScale: Float = 1f, content: @Composable () -> Unit) =
    shoot(
        "workorders", name + if (fontScale != 1f) "-font$fontScale" else "", device, dark, fontScale, tabletop,
        providers = arrayOf(LocalWoClock provides WoClock({ WoSamples.NOW }, ZoneId.of("America/New_York"), ticks = false)),
        content = content,
    )
