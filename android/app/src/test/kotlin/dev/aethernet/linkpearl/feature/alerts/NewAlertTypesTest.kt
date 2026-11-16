package dev.aethernet.linkpearl.feature.alerts

import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The digest, unlinked and coverage types: parsing, words, notifications, settings and the digest look-up. */
@OptIn(ExperimentalCoroutinesApi::class)
class NewAlertTypesTest {
    private val names = mapOf(914 to "Sandbox Store", 326 to "Lynnhaven")
    private fun j(s: String) = Json.parseToJsonElement(s) as JsonObject

    // ---- parsing ---------------------------------------------------------------------------------------------------------

    @Test fun parsesTheDigestExample() {
        val a = alertOf(Contract.digest)
        assertEquals(AlertType.Digest, a.type)
        assertNull(a.wo); assertNull(a.hours)
        val d = a.digest!!
        assertEquals("2026-10-15", d.day); assertEquals("2026-10-14", d.yesterday)
        assertEquals(listOf(326, 914), d.stores); assertTrue(d.manyStores)
        assertEquals(3400.0, d.sales!!, 0.0); assertEquals(170.0, d.splh!!, 0.0); assertEquals(20.0, d.hours!!, 0.0)
        assertEquals(listOf(160, 180), d.target)
        assertEquals(300.0, d.rfpTotal!!, 0.0); assertEquals(3, d.rfpCount); assertEquals(12, d.rfpOldestDays)
        assertEquals(3, d.followupCount)
        assertEquals(listOf(DigestWo(326, 303, null), DigestWo(914, 301, "Ready for pickup"), DigestWo(914, 302, "Diagnostics")), d.followups)
        assertEquals(3, d.stuckDays); assertEquals(2, d.stuckCount)
        assertEquals(listOf(DigestWo(914, 101, "Diagnostics", 5), DigestWo(326, 102, "Work in progress", 4)), d.stuck)
    }

    @Test fun digestNullsStayNullAndMissingPartsAreEmpty() {
        val a = alertOf(j("""{ "id": 1, "store": 914, "type": "digest", "wo": null, "at": "2026-10-15T12:00:00.000Z", "stores": [914],
            "sales": null, "splh": null, "hours": 12.5, "target": [160, 180], "rfp": { "total": null, "count": 0, "oldestDays": null } }"""))
        val d = a.digest!!
        assertNull(d.sales); assertNull(d.splh); assertEquals(12.5, d.hours!!, 0.0); assertFalse(d.manyStores)
        assertNull(d.rfpTotal); assertEquals(0, d.rfpCount); assertNull(d.rfpOldestDays)
        assertNull(d.followupCount); assertEquals(emptyList<DigestWo>(), d.followups); assertNull(d.stuckCount)
        assertEquals("Yesterday — · — per labor hour", DigestText.title(d))
        assertEquals(emptyList<String>(), DigestText.lines(d))
    }

    @Test fun badDigestPartsAreSkippedNotFatal() {
        val a = alertOf(j("""{ "id": 1, "store": 914, "type": "digest", "wo": null, "at": "2026-10-15T12:00:00.000Z",
            "sales": "lots", "target": [160], "followups": { "count": 1, "wos": [ { "wo": 5 }, 7, { "store": 914, "wo": 6, "status": null } ] } }"""))
        val d = a.digest!!
        assertNull(d.sales); assertNull(d.target)
        assertEquals(listOf(DigestWo(914, 6, null)), d.followups)
    }

    @Test fun parsesUnlinkedAndCoverage() {
        val u = alertOf(Contract.unlinked)
        assertEquals(AlertType.Unlinked, u.type); assertEquals(2, u.count); assertEquals(1, u.hours); assertEquals(3, u.oldestHours)
        assertEquals(listOf("FSO1001", "FSO1002"), u.salesOrders)
        val numeric = alertOf(j("""{ "id": 2, "store": 914, "type": "unlinked", "wo": null, "at": "2026-10-15T16:00:00.000Z", "count": 1, "salesOrders": [5012388] }"""))
        assertEquals(listOf("5012388"), numeric.salesOrders)
        val c = alertOf(Contract.coverage)
        assertEquals(AlertType.Coverage, c.type); assertEquals("2026-10-15T15:55:00.000Z", c.checkedAt)
        assertEquals(3, c.countMisses); assertEquals(40, c.countItems); assertEquals(2, c.missedItems); assertEquals(1, c.qtyMisses); assertEquals(4, c.staleLabels)
    }

    @Test fun unknownTypesAreStillDropped() {
        val f = parseFeed(j("""{ "cursor": 9, "alerts": [ { "id": 9, "store": 914, "type": "aging", "wo": null, "at": "2026-10-15T16:00:00.000Z" }, ${Contract.unlinked} ] }"""))!!
        assertEquals(listOf(AlertType.Unlinked), f.alerts.map { it.type })
    }

    // ---- words -----------------------------------------------------------------------------------------------------------

    @Test fun rowSentences() {
        assertEquals("Morning digest", AlertText.sentence(alertOf(Contract.digest), names))
        assertEquals("2 sales orders have no work order", AlertText.sentence(alertOf(Contract.unlinked), names))
        val one = alertOf(Contract.unlinked).copy(count = 1, salesOrders = listOf("5012388"))
        assertEquals("Sales order 5012388 has no work order", AlertText.sentence(one, names))
        assertEquals("1 sales order has no work order", AlertText.sentence(one.copy(salesOrders = emptyList()), names))
        assertEquals("Coverage check: 3 items short of labels, 2 items missed", AlertText.sentence(alertOf(Contract.coverage), names))
        val c = alertOf(Contract.coverage)
        assertEquals("Coverage check: 3 items missed", AlertText.sentence(c.copy(countMisses = 0, missedItems = 3), names))
        assertEquals("Coverage check: 1 item short of labels", AlertText.sentence(c.copy(countMisses = 1, missedItems = 0), names))
        assertEquals("Coverage check", AlertText.sentence(c.copy(countMisses = null, missedItems = null), names))
    }

    @Test fun digestMetaSaysAllStoresWhenItSpansSeveral() {
        assertEquals("All stores · 8:00 AM", AlertText.meta(alertOf(Contract.digest), names))
        val single = alertOf(Contract.digest).let { it.copy(digest = it.digest!!.copy(stores = listOf(326))) }
        assertEquals("Lynnhaven #326 · 8:00 AM", AlertText.meta(single, names))
        assertEquals("Sandbox Store #914 · 12:00 PM", AlertText.meta(alertOf(Contract.unlinked), names))
    }

    @Test fun detailFactsAreLabelledCounts() {
        assertEquals(
            listOf("Sales orders" to "2", "Oldest" to "3 hours", "Longer than" to "1 hour", "Store" to "Sandbox Store #914"),
            AlertText.facts(alertOf(Contract.unlinked), names),
        )
        assertEquals(
            listOf("Short of labels" to "3 of 40", "Missed items" to "2", "Quantity misses" to "1", "Stale labels" to "4", "Checked" to "Thu, Oct 15 11:55 AM", "Store" to "Sandbox Store #914"),
            AlertText.facts(alertOf(Contract.coverage), names),
        )
        val blank = alertOf(Contract.coverage).copy(countMisses = null, missedItems = null, qtyMisses = null, staleLabels = null, checkedAt = null)
        assertTrue(AlertText.facts(blank, names).take(5).all { it.second == "—" })
    }

    @Test fun digestRowLines() {
        val d = alertOf(Contract.digest).digest!!
        assertEquals("Diagnostics · 5 days · Sandbox Store #914", digestWoLine(d.stuck[0], d.manyStores, names))
        assertEquals("Lynnhaven #326", digestWoLine(d.followups[0], d.manyStores, names))
        assertEquals("Repair summary · 1 day", digestWoLine(DigestWo(914, 1, "Repair summary", 1), false, names))
        assertEquals("—", digestWoLine(DigestWo(914, 1, null), false, names))
        assertEquals("Thu, Oct 15", DigestText.date(d))
    }

    // ---- notifications ---------------------------------------------------------------------------------------------------

    @Test fun digestNotificationText() {
        val d = DigestFacts(sales = 2096.0, splh = 168.0, rfpTotal = 885.0, rfpCount = 3, followupCount = 2, stuckCount = 1)
        assertEquals("Yesterday $2,096 · $168 per labor hour", DigestText.title(d))
        assertEquals(listOf("RFP total $885 · 3 waiting", "2 follow-ups due today", "1 work order stuck"), DigestText.lines(d))
        assertEquals(listOf("1 follow-up due today", "4 work orders stuck"), DigestText.lines(d.copy(rfpCount = 0, followupCount = 1, stuckCount = 4)))
        assertEquals(listOf("RFP total — · 2 waiting"), DigestText.lines(DigestFacts(rfpTotal = null, rfpCount = 2, followupCount = 0, stuckCount = 0)))
    }

    @Test fun digestNoteOpensTheDigestScreen() {
        val p = NotificationPlanner.plan(listOf(alertOf(Contract.digest)), names).single()
        assertEquals(AlertType.Digest, p.type)
        assertEquals("Yesterday $3,400 · $170 per labor hour", p.title)
        assertEquals(listOf("RFP total $300 · 3 waiting", "3 follow-ups due today", "2 work orders stuck"), p.lines)
        assertEquals("RFP total $300 · 3 waiting", p.text)
        assertEquals(listOf(530), p.alertIds)
        assertNull(p.workOrder)
        assertEquals("alerts/digest/530", p.tapRoute)
    }

    @Test fun unlinkedAndCoverageNotesAreOneSentenceEach() {
        val p = NotificationPlanner.plan(listOf(alertOf(Contract.unlinked), alertOf(Contract.coverage)), names)
        assertEquals(listOf("2 sales orders have no work order", "Coverage check: 3 items short of labels, 2 items missed"), p.map { it.text })
        assertTrue(p.all { it.title == "Sandbox Store" && it.lines.isEmpty() && it.tapRoute == "alerts" })
    }

    @Test fun tapRoutesForTheOlderTypesAreUnchanged() {
        val stuck = NotificationPlanner.plan(listOf(alertOf(Contract.stuck700000014)), names).single()
        assertEquals("workorders/914-700000014", stuck.tapRoute)
        assertEquals("alerts/digest/{id}", AlertsRoutes.DIGEST)
    }

    @Test fun channelsPerNewType() {
        assertEquals("alerts_digest" to "Morning digest", AlertType.Digest.channelId to AlertType.Digest.channelName)
        assertEquals("alerts_unlinked" to "Sales orders", AlertType.Unlinked.channelId to AlertType.Unlinked.channelName)
        assertEquals("alerts_coverage" to "Coverage check", AlertType.Coverage.channelId to AlertType.Coverage.channelName)
        assertEquals("Stuck work orders", AlertType.Stuck.channelName)
        assertEquals(7, AlertType.configurableTypes.map { it.channelId }.distinct().size)
    }

    // ---- settings --------------------------------------------------------------------------------------------------------

    @Test fun parsesTheNewSettings() {
        val b = parseSettings(Contract.settingsAll)!!
        assertEquals(TypeSetting(true, 8), b.settings.types[AlertType.Digest])
        assertEquals(TypeSetting(true, 1), b.settings.types[AlertType.Unlinked])
        assertEquals(TypeSetting(true, 0), b.settings.types[AlertType.Coverage])
        assertEquals(0..23, b.ranges.digestHour); assertEquals(1..48, b.ranges.unlinkedHours)
        assertEquals(1..48, b.ranges.of(AlertType.Unlinked))
    }

    @Test fun aServerWithoutTheNewTypesStillParses() {
        val b = parseSettings(Contract.settings)!!
        assertEquals(setOf(AlertType.Stuck, AlertType.Pickup, AlertType.Followup, AlertType.Quiet), b.settings.types.keys)
        assertEquals(Ranges.Default.unlinkedHours, b.ranges.unlinkedHours)
    }

    @Test fun newSettingsValidateAgainstTheServerRanges() {
        val b = parseSettings(Contract.settingsAll)!!
        val s = b.settings; val r = b.ranges
        assertNull(SettingsEdit.TypeValue(AlertType.Unlinked, 1).problem(s, r))
        assertNull(SettingsEdit.TypeValue(AlertType.Unlinked, 48).problem(s, r))
        assertEquals("Out of range", SettingsEdit.TypeValue(AlertType.Unlinked, 0).problem(s, r))
        assertEquals("Out of range", SettingsEdit.TypeValue(AlertType.Unlinked, 49).problem(s, r))
        assertNull(SettingsEdit.TypeValue(AlertType.Digest, 0).problem(s, r))
        assertEquals("Out of range", SettingsEdit.TypeValue(AlertType.Digest, 24).problem(s, r))
        assertEquals("Not configurable", SettingsEdit.TypeValue(AlertType.Coverage, 1).problem(s, r))
        assertNull(SettingsEdit.TypeOn(AlertType.Coverage, false).problem(s, r))
        assertFalse(AlertType.Coverage.hasThreshold); assertTrue(AlertType.Digest.hasThreshold)
    }

    @Test fun newSettingsSerializeToTheContractPatchShape() {
        assertEquals(Json.parseToJsonElement("""{"types":{"digest":{"hour":7}}}"""), SettingsEdit.TypeValue(AlertType.Digest, 7).json())
        assertEquals(Json.parseToJsonElement("""{"types":{"unlinked":{"hours":24}}}"""), SettingsEdit.TypeValue(AlertType.Unlinked, 24).json())
        assertEquals(Json.parseToJsonElement("""{"types":{"coverage":{"on":false}}}"""), SettingsEdit.TypeOn(AlertType.Coverage, false).json())
        assertEquals("8:00 AM", thresholdText(AlertType.Digest, 8)); assertEquals("1 hour", thresholdText(AlertType.Unlinked, 1)); assertEquals("", thresholdText(AlertType.Coverage, 0))
    }

    @Test fun coverageSwitchGoesOutAndRollsBack() = runTest {
        val api = FakeApi { m, _, _, _ -> if (m == "GET") ok(Contract.settingsAll) else fail(ApiError.Server) }
        val c = AlertSettingsController(AlertsRemote(api), CoroutineScope(UnconfinedTestDispatcher()))
        c.load()
        assertTrue(c.edit(SettingsEdit.TypeOn(AlertType.Coverage, false)))
        assertEquals(Json.parseToJsonElement("""{"types":{"coverage":{"on":false}}}"""), api.calls.last()[3])
        assertTrue((c.state.value as SettingsUi.Ready).bundle.settings.types[AlertType.Coverage]!!.on)
        assertFalse(c.edit(SettingsEdit.TypeValue(AlertType.Unlinked, 49)))
    }

    // ---- the digest look-up ----------------------------------------------------------------------------------------------

    private fun feedWith(api: FakeApi): AlertsFeed {
        val scope = CoroutineScope(UnconfinedTestDispatcher())
        return AlertsFeed(AlertsRemote(api), scope, AlertsBadges(0, scope), MemoryCheckState())
    }

    @Test fun findUsesTheListFirstThenTheServer() = runTest {
        val page = buildJsonObject { put("cursor", 530); put("unread", 1); put("alerts", kotlinx.serialization.json.JsonArray(listOf(Contract.digest))) }
        val api = FakeApi { _, _, _, _ -> ok(page) }
        val feed = feedWith(api)
        val r = feed.find(530) as ApiResult.Success
        assertEquals(AlertType.Digest, r.value!!.type)
        assertEquals(mapOf("limit" to "1", "store" to "all", "before" to "531"), api.calls.single()[2])
        feed.refresh()
        val calls = api.calls.size
        assertEquals(530, (feed.find(530) as ApiResult.Success).value!!.id)
        assertEquals(calls, api.calls.size)
        assertNull((feed.find(529) as ApiResult.Success).value) // the page starts at 530: 529 is not this phone's
    }

    @Test fun findReportsOffline() = runTest {
        val feed = feedWith(FakeApi { _, _, _, _ -> fail(ApiError.Offline) })
        assertEquals(ApiError.Offline, (feed.find(1) as ApiResult.Failure).error)
    }
}
