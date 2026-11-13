package dev.aethernet.linkpearl.feature.settings.screenshot

import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.feature.settings.SettingsScreen
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.shoot
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Owner of feature/settings: this is your screenshot test. Add your states here; outputs land in android/screenshots/settings/. */
@RunWith(RobolectricTestRunner::class)
class SettingsScreenshotTest {
    @get:Rule val rule = createComposeRule()

    @Test fun phoneDark() = rule.shoot("settings", "stub", Device.Phone, dark = true) { SettingsScreen() }
}
