package dev.aethernet.linkpearl.feature.workorders

import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.data.StoreRef
import dev.aethernet.linkpearl.core.lock.TestAuth
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WorkOrdersViewModelTest {
    private val main = UnconfinedTestDispatcher()
    @Before fun setUp() = Dispatchers.setMain(main)
    @After fun tearDown() = Dispatchers.resetMain()

    private val api = FakeApi()
    private val isList = { p: String, _: Map<String, String> -> p == "/v1/agents/m/wo" }
    private val withCards = { p: String, q: Map<String, String> -> p == "/v1/agents/m/wo" && q["cards"] == "1" }

    private fun vm(lock: FakeAppLock = FakeAppLock(), store: Int? = null) =
        WorkOrdersViewModel(WoRepository(api), lock, TestAuth(), MemoryWoStorePreference(store), nowMs = { 1_000L }, work = main, searchDebounceMs = 0)

    @Test fun lockedListIsPlainWithLaneCounts() = runTest {
        api.on(isList, WoFixtures.LIST_OPEN)
        val s = vm(store = 914).state.value
        assertEquals(LoadView.Ok, s.view)
        assertEquals(listOf(7000001L, 7000003L), s.rows.map { it.wo })
        assertEquals(11, s.lanes!!.total)
        assertTrue(s.hasMore)
        assertTrue(s.names.isEmpty())
        val q = api.calls.single().second
        assertEquals(mapOf("store" to "914", "state" to "open", "sort" to "status", "limit" to "25"), q)
        assertEquals(listOf(StoreRef(914, "Sandbox"), StoreRef(326, "Lynnhaven")), s.stores)
    }

    @Test fun laneFilterSortAndClosed() = runTest {
        api.on(isList, WoFixtures.LIST_OPEN)
        val vm = vm()
        vm.pickFilter(LaneFilter.One(Lane.Rfp))
        assertEquals("rfp", api.calls.last().second["lane"])
        vm.pickSort(WoSort.Updated)
        assertEquals("updated", api.calls.last().second["sort"])
        api.on({ p, q -> p == "/v1/agents/m/wo" && q["state"] == "closed" }, WoWaymarkFixtures.LIST_CLOSED)
        vm.pickFilter(LaneFilter.Closed)
        val q = api.calls.last().second
        assertEquals("closed", q["state"]); assertEquals("closed", q["sort"]); assertNull("no window: every closed work order", q["closedDays"])
        assertTrue(vm.state.value.rows.none { it.open })
        assertEquals("lanes kept from the open list for the chips", 11, vm.state.value.lanes!!.total)
    }

    @Test fun pagingAppendsWithTheCursor() = runTest {
        api.on(isList, WoFixtures.LIST_OPEN)
        val vm = vm()
        api.on({ _, q -> q["after"] != null }, WoFixtures.LIST_RECENT)
        vm.loadMore()
        assertEquals("eyJzIjoic3RhdHVzIiwidCI6Im9wZW4iLCJlIjoifiIsInN0Ijo5MTQsInciOjF9", api.calls.last().second["after"])
        assertEquals(3, vm.state.value.rows.size)
        assertFalse(vm.state.value.hasMore)
    }

    @Test fun unlockedListOpensCardsForNames() = runTest {
        api.on(isList, WoFixtures.LIST_OPEN)
        api.on(withCards, WoFixtures.LIST_CARDS)
        val lock = FakeAppLock()
        val vm = vm(lock)
        assertTrue(vm.state.value.names.isEmpty())
        lock.unlock()
        val s = vm.state.value
        assertTrue(s.unlocked)
        assertEquals("1", api.calls.last().second["cards"])
        assertEquals("Sam Sample", s.names[WoKey(914, 700000123)])
        assertNull("rows never keep the sealed card", s.rows.firstOrNull { it.card != null })
        lock.lock()
        assertTrue("names dropped on lock", vm.state.value.names.isEmpty())
    }

    @Test fun singleKeylessStoreListsWithoutCards() = runTest {
        api.on(isList, WoFixtures.LIST_OPEN)
        val vm = vm(FakeAppLock(unlocked = true), store = 326)
        assertNull(api.calls.last().second["cards"])
        assertEquals(LoadView.Ok, vm.state.value.view)
    }

    @Test fun noKeyAnswerFallsBackToPlain() = runTest {
        api.on(isList, WoFixtures.LIST_OPEN)
        api.fail(withCards, ApiResult.Failure(ApiError.Forbidden, 403, "no key for this store"))
        val vm = vm(FakeAppLock(unlocked = true), store = 914)
        assertEquals(LoadView.Ok, vm.state.value.view)
        assertNull(api.calls.last().second["cards"])
    }

    @Test fun offlineKeepsTheLastListFromMemory() = runTest {
        api.on(isList, WoFixtures.LIST_OPEN)
        val vm = vm()
        api.fail(isList, ApiResult.Failure(ApiError.Offline))
        vm.refresh()
        val s = vm.state.value
        assertEquals(LoadView.Ok, s.view)
        assertEquals(Problem.Offline, s.problem)
        assertEquals(2, s.rows.size)
    }

    @Test fun errorStatesWithNothingToShow() = runTest {
        for ((f, p) in listOf(
            ApiResult.Failure(ApiError.Forbidden, 403, "not your store") to Problem.Forbidden,
            ApiResult.Failure(ApiError.RateLimited, 429, "slow down") to Problem.RateLimited,
            ApiResult.Failure(ApiError.Unauthorized, 401) to Problem.SignedOut,
            ApiResult.Failure(ApiError.Offline) to Problem.Offline,
        )) {
            api.routes.clear(); api.fail(isList, f)
            val s = vm(store = 914 + p.ordinal).state.value
            assertEquals(LoadView.Error, s.view)
            assertEquals(p, s.problem)
        }
    }

    @Test fun numberSearchWorksLocked() = runTest {
        api.on(isList, WoFixtures.LIST_OPEN)
        api.on({ p, _ -> p.endsWith("/find") }, WoFixtures.FIND)
        val vm = vm()
        vm.setQuery("70")
        assertNull("under 3 digits: no search", vm.state.value.search)
        vm.setQuery("70000")
        val s = vm.state.value.search!!
        assertEquals(listOf(7000001L), s.results.map { it.wo })
        assertEquals("70000", api.calls.last().second["q"])
    }

    @Test fun nameSearchNeedsUnlockAndThenMatchesLocally() = runTest {
        api.on(isList, WoFixtures.LIST_OPEN)
        val lock = FakeAppLock()
        val vm = vm(lock)
        vm.setQuery("sample")
        assertTrue(vm.state.value.search!!.needsUnlock)
        assertTrue(api.calls.none { it.second["cards"] == "1" })

        api.on(withCards, WoFixtures.LIST_CARDS)
        api.on({ p, q -> p == "/v1/agents/m/wo" && q["cards"] == "1" && q["state"] == "recent" }, WoFixtures.RECENT_CARDS_EMPTY)
        lock.unlock()
        val s = vm.state.value.search!!
        assertFalse(s.needsUnlock)
        assertEquals(listOf(700000123L), s.results.map { it.wo })
        assertEquals("Sam Sample", vm.state.value.names[WoKey(914, 700000123)])
        // the index was built with cards over all stores, open and recent
        assertTrue(api.calls.any { it.second["cards"] == "1" && it.second["state"] == "recent" && it.second["store"] == "all" })

        lock.lock()
        val after = vm.state.value
        assertTrue("text search hidden again", after.search!!.needsUnlock)
        assertTrue(after.search!!.results.isEmpty())
        assertTrue(after.names.isEmpty())
    }

    @Test fun phoneAndImeiSearchUnlocked() = runTest {
        api.on(isList, WoFixtures.LIST_OPEN)
        api.on(withCards, WoFixtures.LIST_CARDS)
        api.on({ p, q -> p == "/v1/agents/m/wo" && q["cards"] == "1" && q["state"] == "recent" }, WoFixtures.RECENT_CARDS_EMPTY)
        api.on({ p, _ -> p.endsWith("/find") }, """{"v":1,"rows":[],"more":false}""")
        val vm = vm(FakeAppLock(unlocked = true))
        vm.setQuery("555-0123")
        assertEquals(listOf(700000123L), vm.state.value.search!!.results.map { it.wo })
        vm.setQuery("7518")
        assertEquals(listOf(700000123L), vm.state.value.search!!.results.map { it.wo })
        vm.setQuery("9999")
        assertTrue(vm.state.value.search!!.results.isEmpty())
        assertNull(vm.state.value.search!!.problem)
    }

    // ---- closed work orders (state=closed) and Auto-Waymark ------------------------------------------------------------------

    @Test fun closedListPagesWithTheCursorAndKeepsLastCartValue() = runTest {
        api.on(isList, WoFixtures.LIST_OPEN)
        val vm = vm(store = 914)
        api.on({ p, q -> p == "/v1/agents/m/wo" && q["state"] == "closed" && q["after"] == null }, WoWaymarkFixtures.LIST_CLOSED)
        vm.pickFilter(LaneFilter.Closed)
        assertEquals(WoSort.Closed, vm.state.value.sort)
        assertEquals(listOf(7000010L, 7000011L), vm.state.value.rows.map { it.wo })
        assertEquals(149.0, vm.state.value.rows[0].lastCartValue)
        assertEquals("Sale complete", vm.state.value.rows[0].closedReason)
        assertTrue(vm.state.value.hasMore)
        api.on({ p, q -> p == "/v1/agents/m/wo" && q["state"] == "closed" && q["after"] != null }, WoWaymarkFixtures.LIST_CLOSED_LAST)
        vm.loadMore()
        assertEquals("closed", api.calls.last().second["state"])
        assertEquals(listOf(7000010L, 7000011L, 7000012L), vm.state.value.rows.map { it.wo })
        assertEquals("Declined", vm.state.value.rows.last().outcome)
        assertFalse(vm.state.value.hasMore)
        vm.pickFilter(LaneFilter.All)
        assertEquals("open", api.calls.last().second["state"])
        assertEquals("Open again: the sort leaves Closed", WoSort.Status, vm.state.value.sort)
    }

    @Test fun olderTrackerAnswers400ForClosedAndTheListShowsItsErrorState() = runTest {
        api.on(isList, WoFixtures.LIST_OPEN)
        val vm = vm(store = 914)
        api.fail({ p, q -> p == "/v1/agents/m/wo" && q["state"] == "closed" }, ApiResult.Failure(ApiError.Server, 400, "state: open or recent"))
        vm.pickFilter(LaneFilter.Closed)
        assertEquals(LoadView.Error, vm.state.value.view)
        assertEquals(Problem.Server, vm.state.value.problem)
        assertEquals("Couldn't load", problemText(vm.state.value.problem))
        vm.pickFilter(LaneFilter.All)
        assertEquals("the switch goes back to Open", LoadView.Ok, vm.state.value.view)
    }

    @Test fun followUpsChipCountAndFilter() = runTest {
        api.on(isList, WoWaymarkFixtures.LIST_WAYMARK)
        val vm = vm(store = 914)
        val s = vm.state.value
        assertEquals(3, s.followUps!!.count); assertEquals("2026-11-13", s.followUps!!.today)
        assertEquals(listOf("Priority", "Waiting on customer", "One-off"), s.rows[0].tags.map { it.tag })
        assertEquals(FollowUpRule.Callback, s.rows[0].followUp!!.rule)
        api.on({ p, q -> p == "/v1/agents/m/wo" && q["followups"] == "1" }, WoWaymarkFixtures.LIST_FOLLOWUPS)
        vm.pickFilter(LaneFilter.FollowUps)
        val q = api.calls.last().second
        assertEquals("open", q["state"]); assertEquals("1", q["followups"]); assertNull(q["lane"])
        assertEquals(listOf(7000003L), vm.state.value.rows.map { it.wo })
        assertEquals(3, vm.state.value.followUps!!.count)
        vm.pickFilter(LaneFilter.One(Lane.Rfp))
        assertNull("the filter is off for a lane", api.calls.last().second["followups"])
    }

    @Test fun olderTrackerHasNoFollowUpsChipAndNoMarks() = runTest {
        api.on(isList, WoFixtures.LIST_OPEN)
        val s = vm(store = 914).state.value
        assertNull(s.followUps)
        assertTrue(s.rows.all { it.tags.isEmpty() && it.followUp == null })
    }

    @Test fun theNameIndexUsesTheRecentWindowNotEveryClosedWorkOrder() = runTest {
        api.on(isList, WoFixtures.LIST_OPEN)
        api.on(withCards, WoFixtures.LIST_CARDS)
        api.on({ p, q -> p == "/v1/agents/m/wo" && q["cards"] == "1" && q["state"] == "recent" }, WoFixtures.RECENT_CARDS_EMPTY)
        val lock = FakeAppLock(unlocked = true)
        val vm = vm(lock)
        vm.setQuery("sample")
        assertTrue(api.calls.none { it.second["state"] == "closed" })
        assertTrue(api.calls.any { it.second["state"] == "recent" && it.second["closedDays"] == "7" })
    }
}
