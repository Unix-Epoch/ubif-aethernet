package dev.aethernet.linkpearl.feature.update.screenshot

import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.core.design.LocalMotion
import dev.aethernet.linkpearl.core.nav.LpNavScaffold
import dev.aethernet.linkpearl.core.nav.TopLevel
import dev.aethernet.linkpearl.core.prefs.Appearance
import dev.aethernet.linkpearl.feature.settings.SettingsScreen
import dev.aethernet.linkpearl.feature.settings.SettingsUiState
import dev.aethernet.linkpearl.feature.update.AppVersion
import dev.aethernet.linkpearl.feature.update.MinVersion
import dev.aethernet.linkpearl.feature.update.Release
import dev.aethernet.linkpearl.feature.update.UpdateNeededScreen
import dev.aethernet.linkpearl.feature.update.UpdatePhase
import dev.aethernet.linkpearl.feature.update.UpdateState
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.shoot
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.ParameterizedRobolectricTestRunner.Parameters

/** Settings with an update (in the nav, as in the mock-up), and the blocking "Update needed" (idle, downloading, failed). Fake data. */
@RunWith(ParameterizedRobolectricTestRunner::class)
class UpdateScreenshotTest(private val device: Device, private val dark: Boolean) {
    companion object {
        @JvmStatic @Parameters(name = "{0} dark={1}")
        fun params() = listOf(Device.Phone, Device.Cover).flatMap { d -> listOf(true, false).map { arrayOf<Any>(d, it) } }
    }

    @get:Rule val rule = createComposeRule()

    private val release = Release(6, "1.2.0", 4_100_000, "1b28064f4d6462f8e9116e726b0171876a2f81cd261f02c179c5d0c75c3effc4")
    private val available = UpdateState(AppVersion(4, "1.1.1"), latest = release, min = MinVersion(1, "1.0.0"))
    private val required = available.copy(min = MinVersion(6, "1.2.0"))
    private val settings = SettingsUiState(phoneName = "Fold 8", unlocked = false, notificationsOn = true)

    private fun settingsShot(name: String, update: UpdateState) = rule.shoot("settings", name, device, dark) {
        LpNavScaffold(selected = TopLevel.Settings, onSelect = {}, badges = mapOf(TopLevel.Alerts to 3), dots = setOf(TopLevel.Settings)) {
            SettingsScreen(settings.copy(appearance = if (dark) Appearance.Dark else Appearance.Light), "1.1.1", update = update)
        }
    }

    @Test fun settingsUpdateAvailable() = settingsShot("update-available", available)
    @Test fun settingsUpdateDownloading() = settingsShot("update-downloading", available.copy(phase = UpdatePhase.Downloading(2_540_000, 4_100_000)))
    @Test fun settingsUpdateFailed() = settingsShot("update-failed", available.copy(phase = UpdatePhase.Failed(UpdatePhase.DOWNLOAD_FAILED)))

    // Drawn at rest: nothing else on this screen animates, so the test clock would stop before the bar has grown in.
    private val still = arrayOf<androidx.compose.runtime.ProvidedValue<*>>(LocalMotion provides false)

    @Test fun neededIdle() = rule.shoot("update", "needed", device, dark, providers = still) { UpdateNeededScreen(required) }
    @Test fun neededDownloading() = rule.shoot("update", "needed-downloading", device, dark, providers = still) {
        UpdateNeededScreen(required.copy(phase = UpdatePhase.Downloading(2_540_000, 4_100_000)))
    }
    @Test fun neededFailed() = rule.shoot("update", "needed-failed", device, dark, providers = still) {
        UpdateNeededScreen(required.copy(phase = UpdatePhase.Failed(UpdatePhase.DOWNLOAD_FAILED)))
    }
    @Test fun neededFontScale() = rule.shoot("update", "needed-font13", device, dark, fontScale = 1.3f, providers = still) {
        UpdateNeededScreen(required.copy(phase = UpdatePhase.Downloading(2_540_000, 4_100_000)))
    }
}
