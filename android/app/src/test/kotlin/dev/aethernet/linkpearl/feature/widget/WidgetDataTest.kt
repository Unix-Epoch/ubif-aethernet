package dev.aethernet.linkpearl.feature.widget

import dev.aethernet.linkpearl.core.data.HomeData
import dev.aethernet.linkpearl.core.data.HomeRepository
import dev.aethernet.linkpearl.core.data.HomeResult
import dev.aethernet.linkpearl.core.data.FailureReason
import dev.aethernet.linkpearl.core.data.LinkpearlJson
import dev.aethernet.linkpearl.core.data.StoreScope
import dev.aethernet.linkpearl.core.data.fixture
import dev.aethernet.linkpearl.core.design.TargetState
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

@OptIn(ExperimentalCoroutinesApi::class)
class WidgetDataTest {
    private val one: HomeData = LinkpearlJson.decodeFromString(HomeData.serializer(), fixture("home-one").body)
    /** 12:30 PM in New York on the fixture's day. */
    private val sameDay = Instant.parse("2026-11-13T17:30:00Z").toEpochMilli()

    @Test fun mapsOneStore() {
        val s = WidgetSnapshot.from(StoreScope.One(914), one)
        assertEquals("914", s.scope)
        assertEquals("Newport News #914", s.store)
        val ui = WidgetUi.from(s, sameDay)
        assertEquals("12:13 PM", ui.asOf)
        assertEquals("$1,800", ui.sales)
        assertEquals("$1,910", ui.yesterday)
        assertEquals("$150", ui.splh)
        assertEquals(TargetState.Under, ui.target)
        assertEquals("$485", ui.rfpTotal)
        assertEquals("2 · 12 days", ui.rfpLine)
        assertEquals("2 ready for pickup, oldest 12 days", ui.rfpDescription)
        assertEquals("3", ui.open)
        // Lanes with work orders only, in Home's order.
        assertEquals(listOf(Lane.Order to 1, Lane.Work to 1, Lane.Rfp to 1), ui.lanes)
        assertEquals("Need to order 1, Work started 1, Ready for pickup 1", ui.lanesDescription)
    }

    @Test fun barsAreScaledToTheBestDayAndTodayIsLast() {
        val ui = WidgetUi.from(WidgetSnapshot.from(StoreScope.One(914), one), sameDay)
        assertEquals(7, ui.bars.size)
        assertEquals(1f, ui.bars[0].fraction!!, 0.0001f)
        assertEquals(1800f / 2460f, ui.bars[6].fraction!!, 0.0001f)
        assertTrue(ui.bars[6].today)
        assertFalse(ui.bars.dropLast(1).any { it.today })
    }

    @Test fun allStoresAndUnknownStoreLabels() {
        assertEquals("All stores", WidgetSnapshot.from(StoreScope.All, one).store)
        assertEquals("#1234", WidgetSnapshot.from(StoreScope.One(1234), one).store)
    }

    @Test fun anOlderAnswerShowsItsWeekday() {
        val nextDay = Instant.parse("2026-11-14T15:00:00Z").toEpochMilli()
        assertEquals("Fri 12:13 PM", WidgetUi.from(WidgetSnapshot.from(StoreScope.All, one), nextDay).asOf)
    }

    @Test fun missingNumbersAreDashesNeverZero() {
        val s = WidgetSnapshot(scope = "all", store = "All stores", week = listOf(null, null, 10.0), rfpCount = 0, lanes = listOf(0, 0, 0, 0, 0), open = 0)
        val ui = WidgetUi.from(s, sameDay)
        assertEquals("—", ui.sales)
        assertEquals("—", ui.yesterday)
        assertEquals("—", ui.splh)
        assertNull(ui.target)
        assertEquals("—", ui.rfpTotal)
        assertEquals("0", ui.rfpLine)
        assertEquals("", ui.asOf)
        assertNull(ui.bars[0].fraction)
        assertTrue(ui.lanes.isEmpty())
    }

    @Test fun nothingSavedIsTheEmptyWidget() {
        assertEquals(WidgetUi.Empty, WidgetUi.from(null))
        assertEquals("Linkpearl", WidgetUi.Empty.store)
    }

    @Test fun targetRuleMatchesHome() {
        fun state(v: Double) = WidgetUi.from(WidgetSnapshot(scope = "all", store = "x", splh = v, target = listOf(160, 180))).target
        assertEquals(TargetState.Under, state(159.0))
        assertEquals(TargetState.On, state(160.0))
        assertEquals(TargetState.On, state(180.0))
        assertEquals(TargetState.Over, state(181.0))
    }

    @Test fun snapshotHoldsNoCustomerOrStaffFields() {
        val names = WidgetSnapshot::class.java.declaredFields.map { it.name.lowercase() }
        listOf("customer", "name", "phone", "email", "tech", "staff", "employee").forEach { word ->
            assertFalse("$word in $names", names.any { it.contains(word) })
        }
    }

    // ---- refresher

    private class Hosts(var ids: List<Int>) : WidgetHosts {
        var redraws = 0
        override suspend fun appWidgetIds() = ids
        override suspend fun redraw() { redraws++ }
    }

    private class Repo(private val data: HomeData) : HomeRepository {
        val asked = mutableListOf<String>()
        var offline = false
        override suspend fun load(scope: StoreScope, fresh: Boolean): HomeResult {
            asked += scope.key
            return if (offline) HomeResult.Failed(FailureReason.Offline) else HomeResult.Ok(data)
        }
    }

    @Test fun refreshFetchesEachScopeOnceAndUnconfiguredWidgetsFollowHome() = runTest {
        val hosts = Hosts(listOf(1, 2, 3))
        val repo = Repo(one)
        val r = WidgetRefresher(hosts, repo, MemoryWidgetConfig(mapOf(1 to "914", 2 to "914")), WidgetSnapshots(), MutableStateFlow(StoreScope.All), this)
        assertTrue(r.refreshAll())
        assertEquals(setOf("914", "all"), repo.asked.toSet())
        assertEquals(2, repo.asked.size)
        assertEquals(1, hosts.redraws)
        assertEquals("Newport News #914", r.snapshotFor(1).first()!!.store)
        assertEquals("All stores", r.snapshotFor(3).first()!!.store)
    }

    @Test fun noWidgetsNoFetch() = runTest {
        val repo = Repo(one)
        val r = WidgetRefresher(Hosts(emptyList()), repo, MemoryWidgetConfig(), WidgetSnapshots(), MutableStateFlow(StoreScope.All), this)
        assertFalse(r.refreshAll())
        assertTrue(repo.asked.isEmpty())
    }

    @Test fun offlineKeepsTheSavedNumbers() = runTest {
        val repo = Repo(one)
        val r = WidgetRefresher(Hosts(listOf(1)), repo, MemoryWidgetConfig(), WidgetSnapshots(), MutableStateFlow(StoreScope.All), this)
        r.refreshAll()
        repo.offline = true
        r.refreshAll()
        assertEquals("$1,800", WidgetUi.from(r.snapshotFor(1).first()).sales)
    }

    @Test fun nonForcedRefreshSoonAfterIsOnlyARedraw() = runTest {
        var now = 0L
        val repo = Repo(one)
        val hosts = Hosts(listOf(1))
        val r = WidgetRefresher(hosts, repo, MemoryWidgetConfig(), WidgetSnapshots(), MutableStateFlow(StoreScope.All), this, nowMs = { now })
        r.refreshAll(force = true)
        now += 60_000
        r.refreshAll(force = false)
        assertEquals(1, repo.asked.size)
        assertEquals(2, hosts.redraws)
    }

    @Test fun homeFetchFeedsOnlyScopesInUse() = runTest {
        val hosts = Hosts(listOf(1))
        val r = WidgetRefresher(hosts, Repo(one), MemoryWidgetConfig(mapOf(1 to "914")), WidgetSnapshots(), MutableStateFlow(StoreScope.All), this)
        val home = WidgetFeedingHomeRepository(Repo(one)) { s, d -> r.onHome(s, d) }
        home.load(StoreScope.All)
        advanceUntilIdle()
        assertTrue(r.snapshots.all.value.isEmpty())
        home.load(StoreScope.One(914))
        advanceUntilIdle()
        assertEquals(setOf("914"), r.snapshots.all.value.keys)
        assertEquals(1, hosts.redraws)
    }

    @Test fun signedOutShowsNothingAndClearForgets() = runTest {
        val signedIn = MutableStateFlow(true)
        val r = WidgetRefresher(Hosts(listOf(1)), Repo(one), MemoryWidgetConfig(), WidgetSnapshots(), MutableStateFlow(StoreScope.All), this, signedIn = signedIn)
        r.refreshAll()
        assertEquals("All stores", r.snapshotFor(1).first()!!.store)
        signedIn.value = false
        assertNull(r.snapshotFor(1).first())
        r.clear()
        assertTrue(r.snapshots.all.value.isEmpty())
    }
}
