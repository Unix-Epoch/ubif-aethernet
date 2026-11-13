package dev.aethernet.linkpearl.feature.workorders.screenshot

import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.feature.workorders.WorkOrdersScreen
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.shoot
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Owner of feature/workorders: this is your screenshot test. Add your states here; outputs land in android/screenshots/workorders/. */
@RunWith(RobolectricTestRunner::class)
class WorkOrdersScreenshotTest {
    @get:Rule val rule = createComposeRule()

    @Test fun phoneDark() = rule.shoot("workorders", "stub", Device.Phone, dark = true) { WorkOrdersScreen() }
}
