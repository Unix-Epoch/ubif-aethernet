package dev.aethernet.linkpearl.feature.alerts.screenshot

import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.core.nav.LpNavScaffold
import dev.aethernet.linkpearl.core.nav.TopLevel
import dev.aethernet.linkpearl.feature.alerts.Alert
import dev.aethernet.linkpearl.feature.alerts.AlertSettingsScreen
import dev.aethernet.linkpearl.feature.alerts.AlertType
import dev.aethernet.linkpearl.feature.alerts.AlertsActions
import dev.aethernet.linkpearl.feature.alerts.AlertsContent
import dev.aethernet.linkpearl.feature.alerts.EditorStyle
import dev.aethernet.linkpearl.feature.alerts.FeedStatus
import dev.aethernet.linkpearl.feature.alerts.FeedUi
import dev.aethernet.linkpearl.feature.alerts.QuietHours
import dev.aethernet.linkpearl.feature.alerts.AlertSettings
import dev.aethernet.linkpearl.feature.alerts.Ranges
import dev.aethernet.linkpearl.feature.alerts.SettingsBundle
import dev.aethernet.linkpearl.feature.alerts.SettingsUi
import dev.aethernet.linkpearl.feature.alerts.TypeSetting
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.shoot
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.ParameterizedRobolectricTestRunner.Parameters

enum class AlertScenario(val key: String) {
    Feed("feed"), DetailStore("detail-store"), DetailWorkOrder("detail-wo"), Settings("settings"), Threshold("threshold"),
    Empty("empty"), NotificationsOff("notifications-off"), Offline("offline"), Loading("loading"), Error("error"),
}

/** Sample data in the mockups' story: Nov 13, 4:14 PM at the store (EST), three unread today. */
object AlertFixtures {
    const val NOW = "2026-11-13T21:14:00.000Z"
    val names = mapOf(999999 to "Sandbox Store", 326 to "Lynnhaven")
    val storeIds = listOf(999999, 326)

    val quiet = Alert(id = 7, store = 326, type = AlertType.Quiet, wo = null, at = "2026-11-13T20:40:00.000Z", since = "2026-11-13T18:40:00.000Z", hours = 2)
    val stuck = Alert(id = 6, store = 999999, type = AlertType.Stuck, wo = 700000014, at = "2026-11-13T19:05:00.000Z", statusId = 9, status = "Repair summary", days = 5, since = "2026-11-08T20:58:00.000Z")
    val followup = Alert(id = 5, store = 999999, type = AlertType.Followup, wo = 700000003, at = "2026-11-13T14:00:00.000Z", due = "2026-11-13", kind = "rfp")
    val pickup = Alert(id = 4, store = 999999, type = AlertType.Pickup, wo = null, at = "2026-11-12T14:00:00.000Z", count = 3, days = 7, oldestDays = 11, read = true)
    val stuck9 = Alert(id = 3, store = 326, type = AlertType.Stuck, wo = 700000009, at = "2026-11-12T16:15:00.000Z", statusId = 7, status = "Diagnostics", days = 3, since = "2026-11-09T16:15:00.000Z", read = true)
    val followup16 = Alert(id = 2, store = 999999, type = AlertType.Followup, wo = 700000016, at = "2026-11-11T14:00:00.000Z", due = "2026-11-11", read = true)
    val feed = FeedUi(alerts = listOf(quiet, stuck, followup, pickup, stuck9, followup16), loaded = true, unread = 3, now = NOW, loadedAt = NOW)

    val settings = SettingsUi.Ready(
        SettingsBundle(
            AlertSettings(
                mapOf(AlertType.Stuck to TypeSetting(true, 3), AlertType.Pickup to TypeSetting(true, 7), AlertType.Followup to TypeSetting(true, 9), AlertType.Quiet to TypeSetting(true, 2)),
                QuietHours(true, "22:00", "07:00"), mapOf(999999 to true, 326 to true),
            ),
            Ranges.Default, storeIds,
        ),
    )
}

/** The Alerts screens at phone / Fold cover / Fold inner sizes, dark and light, inside the navigation chrome. */
@RunWith(ParameterizedRobolectricTestRunner::class)
class AlertsScreenshotTest(private val device: Device, private val scenario: AlertScenario, private val dark: Boolean) {
    @get:Rule val rule = createComposeRule()

    companion object {
        @JvmStatic
        @Parameters(name = "{0} {1} dark={2}")
        fun params(): List<Array<Any>> = buildList {
            for (d in listOf(Device.Phone, Device.Cover, Device.Inner, Device.InnerMedium))
                for (s in AlertScenario.entries)
                    for (dark in listOf(true, false)) add(arrayOf(d, s, dark))
        }
    }

    @Test
    fun render() = rule.shoot("alerts", scenario.key, device, dark) {
        val f = AlertFixtures
        LpNavScaffold(selected = TopLevel.Alerts, onSelect = {}, badges = mapOf(TopLevel.Alerts to 3)) {
            when (scenario) {
                AlertScenario.Settings -> AlertSettingsScreen(f.settings, f.names, f.storeIds, onEdit = {}, onBack = { }, onRetry = {})
                AlertScenario.Threshold -> AlertSettingsScreen(f.settings, f.names, f.storeIds, onEdit = {}, onBack = {}, onRetry = {}, editorStyle = EditorStyle.InlineSheet, initialEditing = AlertType.Stuck)
                AlertScenario.Feed -> content(f.feed, selected = null)
                AlertScenario.DetailStore -> content(f.feed, selected = f.quiet.id)
                AlertScenario.DetailWorkOrder -> content(f.feed, selected = f.stuck.id)
                AlertScenario.Empty -> content(FeedUi(loaded = true, unread = 0, now = f.NOW), selected = null)
                AlertScenario.NotificationsOff -> content(f.feed.copy(alerts = listOf(f.stuck)), selected = null, notificationsOn = false)
                AlertScenario.Offline -> content(f.feed.copy(status = FeedStatus.Offline, loadedAt = "2026-11-13T20:02:00.000Z"), selected = null)
                AlertScenario.Loading -> content(FeedUi(), selected = null)
                AlertScenario.Error -> content(FeedUi(status = FeedStatus.Error), selected = null)
            }
        }
    }

    @androidx.compose.runtime.Composable
    private fun content(ui: FeedUi, selected: Int?, notificationsOn: Boolean = true, editing: Boolean = false) {
        val f = AlertFixtures
        AlertsContent(
            ui, f.names, f.storeIds, notificationsOn, f.settings, AlertsActions(),
            initialSelection = selected, initialEditing = editing,
            editorStyle = if (editing) EditorStyle.InlineSheet else null,
        )
    }
}
