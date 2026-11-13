package dev.aethernet.linkpearl.feature.settings.screenshot

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.border
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.prefs.Appearance
import dev.aethernet.linkpearl.feature.settings.ForgetConfirm
import dev.aethernet.linkpearl.feature.settings.SettingsActions
import dev.aethernet.linkpearl.feature.settings.SettingsScreen
import dev.aethernet.linkpearl.feature.settings.SettingsUiState
import dev.aethernet.linkpearl.feature.settings.StoreLine
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.shoot
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.ParameterizedRobolectricTestRunner.Parameters

/** Settings at phone and cover sizes (the wide sizes are in WideChromeScreenshotTest, inside the bottom bar), dark and light; locked/unlocked, notifications on/off, the confirm dialog's content. */
@RunWith(ParameterizedRobolectricTestRunner::class)
class SettingsScreenshotTest(private val device: Device, private val dark: Boolean) {
    companion object {
        @JvmStatic @Parameters(name = "{0} dark={1}")
        fun params() = listOf(Device.Phone, Device.Cover).flatMap { d -> listOf(true, false).map { arrayOf<Any>(d, it) } }
    }

    @get:Rule val rule = createComposeRule()

    private val base = SettingsUiState(
        phoneName = "Pixel Fold",
        stores = listOf(StoreLine(914, "Newport News #914", "4:12 PM"), StoreLine(326, "Lynnhaven #326", "1:40 PM")),
        unlocked = false, notificationsOn = true, appearance = Appearance.Dark,
    )
    private val version = "1.0.0 (1)"

    @Test fun locked() = rule.shoot("settings", "locked", device, dark) { SettingsScreen(base.copy(appearance = if (dark) Appearance.Dark else Appearance.Light), version) }
    @Test fun unlockedNotificationsOff() = rule.shoot("settings", "unlocked-notifications-off", device, dark) {
        SettingsScreen(base.copy(unlocked = true, notificationsOn = false, appearance = Appearance.System), version)
    }
    @Test fun storesWithoutTimes() = rule.shoot("settings", "offline", device, dark) {
        SettingsScreen(base.copy(stores = base.stores.map { it.copy(updated = null) }, appearance = Appearance.Light), version)
    }
    @Test fun confirm() = rule.shoot("settings", "confirm", device, dark) {
        SettingsScreen(base, version)
        Box(Modifier.fillMaxSize().background(Lp.colors.shade), contentAlignment = Alignment.Center) {
            Box(Modifier.padding(24.dp).background(Lp.colors.surf, LpShapes.Card).border(1.dp, Lp.colors.line, LpShapes.Card).padding(16.dp)) { ForgetConfirm(SettingsActions()) }
        }
    }
    @Test fun fontScale() = rule.shoot("settings", "font13", device, dark, fontScale = 1.3f) { SettingsScreen(base.copy(notificationsOn = false), version) }
}
