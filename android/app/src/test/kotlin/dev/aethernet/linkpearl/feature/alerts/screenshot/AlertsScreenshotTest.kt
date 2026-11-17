package dev.aethernet.linkpearl.feature.alerts.screenshot

import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.core.nav.LpNavScaffold
import dev.aethernet.linkpearl.core.nav.TopLevel
import dev.aethernet.linkpearl.feature.alerts.Alert
import dev.aethernet.linkpearl.feature.alerts.AlertSettingsScreen
import dev.aethernet.linkpearl.feature.alerts.AlertType
import dev.aethernet.linkpearl.feature.alerts.DigestFacts
import dev.aethernet.linkpearl.feature.alerts.DigestScreen
import dev.aethernet.linkpearl.feature.alerts.DigestUi
import dev.aethernet.linkpearl.feature.alerts.DigestWo
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
    // Phone and inner only (see params).
    Digest("digest"), DetailUnlinked("detail-unlinked"), DetailCoverage("detail-coverage");

    val phoneAndInnerOnly: Boolean get() = this == Digest || this == DetailUnlinked || this == DetailCoverage
}

/** Sample data in the mockups' story: Nov 13, 4:14 PM at the store (EST), three unread today. */
object AlertFixtures {
    const val NOW = "2026-11-13T21:14:00.000Z"
    val names = mapOf(999999 to "Sandbox Store", 326 to "Lynnhaven")
    val storeIds = listOf(999999, 326)

    val unlinked = Alert(id = 10, store = 999999, type = AlertType.Unlinked, wo = null, at = "2026-11-13T20:55:00.000Z", count = 2, hours = 1, oldestHours = 3, salesOrders = listOf("5012391", "5012394"))
    val quiet = Alert(id = 7, store = 326, type = AlertType.Quiet, wo = null, at = "2026-11-13T20:40:00.000Z", since = "2026-11-13T18:40:00.000Z", hours = 2, read = true)
    val coverage = Alert(id = 9, store = 326, type = AlertType.Coverage, wo = null, at = "2026-11-13T19:30:00.000Z", checkedAt = "2026-11-13T19:25:00.000Z", countMisses = 0, countItems = 40, missedItems = 3, qtyMisses = 1, staleLabels = 4)
    val stuck = Alert(id = 6, store = 999999, type = AlertType.Stuck, wo = 700000014, at = "2026-11-13T19:05:00.000Z", statusId = 9, status = "Repair summary", days = 5, since = "2026-11-08T20:58:00.000Z")
    val followup = Alert(id = 5, store = 999999, type = AlertType.Followup, wo = 700000003, at = "2026-11-13T14:00:00.000Z", due = "2026-11-13", kind = "rfp", read = true)
    val digestFacts = DigestFacts(
        day = "2026-11-13", yesterday = "2026-11-12", stores = listOf(999999, 326), sales = 2096.0, splh = 168.0, hours = 12.5, target = listOf(160, 180),
        rfpTotal = 885.0, rfpCount = 3, rfpOldestDays = 12,
        followupCount = 2, followups = listOf(DigestWo(999999, 700000003, "Callback"), DigestWo(326, 700000016, "Ready for pickup")),
        stuckDays = 3, stuckCount = 1, stuck = listOf(DigestWo(999999, 700000014, "Repair summary", 5)),
    )
    val digest = Alert(id = 8, store = 999999, type = AlertType.Digest, wo = null, at = "2026-11-13T13:00:00.000Z", digest = digestFacts, read = true)
    val unlinkedOne = Alert(id = 11, store = 326, type = AlertType.Unlinked, wo = null, at = "2026-11-12T23:10:00.000Z", count = 1, hours = 1, oldestHours = 2, salesOrders = listOf("5012388"), read = true)
    val pickup = Alert(id = 4, store = 999999, type = AlertType.Pickup, wo = null, at = "2026-11-12T14:00:00.000Z", count = 3, days = 7, oldestDays = 11, read = true)
    val stuck9 = Alert(id = 3, store = 326, type = AlertType.Stuck, wo = 700000009, at = "2026-11-12T16:15:00.000Z", statusId = 7, status = "Diagnostics", days = 3, since = "2026-11-09T16:15:00.000Z", read = true)
    val followup16 = Alert(id = 2, store = 999999, type = AlertType.Followup, wo = 700000016, at = "2026-11-11T14:00:00.000Z", due = "2026-11-11", read = true)
    val feed = FeedUi(
        alerts = listOf(unlinked, quiet, coverage, stuck, followup, digest, unlinkedOne, stuck9, pickup, followup16),
        loaded = true, unread = 3, now = NOW, loadedAt = NOW,
    )

    val settings = SettingsUi.Ready(
        SettingsBundle(
            AlertSettings(
                mapOf(
                    AlertType.Stuck to TypeSetting(true, 3), AlertType.Pickup to TypeSetting(true, 7), AlertType.Followup to TypeSetting(true, 9), AlertType.Quiet to TypeSetting(true, 2),
                    AlertType.Digest to TypeSetting(true, 8), AlertType.Unlinked to TypeSetting(true, 1), AlertType.Coverage to TypeSetting(true),
                ),
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
                for (s in AlertScenario.entries.filter { !it.phoneAndInnerOnly || d == Device.Phone || d == Device.Inner })
                    for (dark in listOf(true, false)) add(arrayOf(d, s, dark))
        }
    }

    @Test
    fun render() = rule.shoot("alerts", scenario.key, device, dark) {
        val f = AlertFixtures
        // The digest is its own destination: no bottom bar on phones (the rail stays on wide screens), as in the app.
        LpNavScaffold(selected = TopLevel.Alerts, onSelect = {}, badges = mapOf(TopLevel.Alerts to 3), showBar = scenario != AlertScenario.Digest) {
            when (scenario) {
                AlertScenario.Digest -> DigestScreen(DigestUi.Ready(f.digest), f.names, onBack = {}, onRetry = {}, onOpenWorkOrder = { _, _ -> })
                AlertScenario.DetailUnlinked -> content(f.feed, selected = f.unlinked.id)
                AlertScenario.DetailCoverage -> content(f.feed, selected = f.coverage.id)
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
