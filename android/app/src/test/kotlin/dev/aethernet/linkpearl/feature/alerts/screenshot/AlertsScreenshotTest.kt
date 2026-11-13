package dev.aethernet.linkpearl.feature.alerts.screenshot

import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.feature.alerts.AlertsScreen
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.shoot
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Owner of feature/alerts: this is your screenshot test. Add your states here; outputs land in android/screenshots/alerts/. */
@RunWith(RobolectricTestRunner::class)
class AlertsScreenshotTest {
    @get:Rule val rule = createComposeRule()

    @Test fun phoneDark() = rule.shoot("alerts", "stub", Device.Phone, dark = true) { AlertsScreen() }
}
