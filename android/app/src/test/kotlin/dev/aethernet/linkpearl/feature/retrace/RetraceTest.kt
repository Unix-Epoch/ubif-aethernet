package dev.aethernet.linkpearl.feature.retrace

import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.lock.TestAuth
import dev.aethernet.linkpearl.feature.workorders.FakeApi
import dev.aethernet.linkpearl.feature.workorders.LoadView
import dev.aethernet.linkpearl.feature.workorders.MemoryWoStorePreference
import dev.aethernet.linkpearl.feature.workorders.Problem
import dev.aethernet.linkpearl.feature.workorders.WoJson
import dev.aethernet.linkpearl.feature.workorders.problemText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
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

/** Retrace: parsing of every response (the docs' examples), the repository's calls, and the view models. */
@OptIn(ExperimentalCoroutinesApi::class)
class RetraceTest {
    private val main = UnconfinedTestDispatcher()
    @Before fun setUp() = Dispatchers.setMain(main)
    @After fun tearDown() = Dispatchers.resetMain()

    private val api = FakeApi()
    private val items = { p: String, _: Map<String, String> -> p == "/v1/agents/m/retrace/items" }
    private val pos = { p: String, _: Map<String, String> -> p == "/v1/agents/m/retrace/pos" }

    private fun vm(saved: Int? = null) = RetraceViewModel(RetraceRepository(api), TestAuth(), MemoryWoStorePreference(saved), nowMs = { 1_000L }, searchDebounceMs = 0)

    // ---- parsing -------------------------------------------------------------------------------------------------------------

    @Test fun itemsParse() {
        val r = WoJson.decodeFromString(RtItemsResponse.serializer(), RetraceFixtures.ITEMS)
        assertEquals(914, r.store); assertEquals("2026-11-14T00:36:03.192Z", r.asOf); assertNull(r.labels); assertTrue(r.next!!.isNotEmpty())
        assertEquals(RtItemRow("176255", "Galaxy S23 screen", "Screens", 3, 6, "2026-11-14T00:06:03.186Z"), r.items[0])
        assertNull("onHand is null without a stock lookup", r.items[1].onHand); assertEquals(122, r.items[1].available)
        val j = WoJson.decodeFromString(RtItemsResponse.serializer(), RetraceFixtures.ITEMS_LABEL_JUMP)
        assertTrue(j.items.isEmpty()); assertEquals(RtLabelHit("176255-0000514371", "176255", "Galaxy S23 screen", "Sold", "out"), j.labels!!.single())
        assertNull(WoJson.decodeFromString(RtItemsResponse.serializer(), RetraceFixtures.ITEMS_EMPTY).asOf)
    }

    @Test fun itemParsesAndCountsAddUpPerGroup() {
        val r = WoJson.decodeFromString(RtItemResponse.serializer(), RetraceFixtures.ITEM)
        assertEquals("Galaxy S23 screen", r.info!!.name); assertEquals(5, r.labelsTotal); assertEquals(3, r.labels.size); assertEquals(3, r.movements.size)
        assertEquals(mapOf(NowGroup.In to 2, NowGroup.Q to 1, NowGroup.Wo to 1, NowGroup.Out to 1), r.groupCounts())   // the unmapped group has no tile
        assertEquals("7000002", r.labels[2].wo); assertNull(r.labels[0].wo)
        assertNull(r.movements[1].ref); assertNull(r.movements[2].label)
        assertEquals("WO 7000002", r.movements[2].ref!!.text()); assertEquals("PO UBFPO000000001", r.movements[0].ref!!.text())
        assertEquals("Used on repair", RtKinds.words("used")); assertEquals("Some new kind", RtKinds.words("some_new_kind"))
    }

    @Test fun labelParsesOldestFirstAndWithoutARow() {
        val r = WoJson.decodeFromString(RtLabelResponse.serializer(), RetraceFixtures.LABEL)
        assertEquals("FSO000011111", r.row!!.salesOrder); assertEquals("7000010", r.row!!.wo); assertEquals(3, r.movementsTotal)
        assertEquals(listOf("received", "reserved", "sold"), r.movements.map { it.kind })
        assertEquals("Sales order FSO000011111", r.movements[1].ref!!.text())
        val n = WoJson.decodeFromString(RtLabelResponse.serializer(), RetraceFixtures.LABEL_NO_ROW)
        assertNull(n.row); assertEquals("warehouse_table", n.movements[0].refType); assertEquals("X1", n.movements[0].ref!!.text())
    }

    @Test fun posParseTotalsAndReceivedText() {
        val r = WoJson.decodeFromString(RtPosResponse.serializer(), RetraceFixtures.POS)
        assertEquals(listOf("Backorder", "Received", "Draft"), r.pos.map { it.status })
        assertEquals(120.0, r.pos[0].total); assertNull(r.pos[2].total); assertNull(r.pos[2].labels); assertNull(r.pos[2].received)
        assertEquals("2 of 3 received", receivedText(r.pos[1])); assertEquals("0 of 0 received", receivedText(r.pos[0])); assertEquals("—", receivedText(r.pos[2]))
        assertEquals("2 received", receivedText(RtPoRow("x", received = 2, labels = null)))
        assertNull(WoJson.decodeFromString(RtPosResponse.serializer(), RetraceFixtures.POS_LAST).pos[0].date)
    }

    @Test fun groupsAndUnknownValuesAreTolerated() {
        assertEquals(NowGroup.Out, NowGroup.of("out")); assertNull(NowGroup.of(null)); assertNull(NowGroup.of("future"))
        val r = WoJson.decodeFromString(RtItemResponse.serializer(), """{"counts":[{"now":"X","group":"future","n":2}],"labels":[{"label":"a","group":"future","extra":1}],"newField":1}""")
        assertTrue(r.groupCounts().isEmpty()); assertEquals("a", r.labels[0].label)
    }

    // ---- repository ----------------------------------------------------------------------------------------------------------

    @Test fun repositoryCalls() = runBlocking {
        api.on({ _, _ -> true }, RetraceFixtures.ITEMS)
        val repo = RetraceRepository(api)
        repo.items(914, " 1762 ".trim(), "cur", 25)
        assertEquals("/v1/agents/m/retrace/items" to mapOf("store" to "914", "limit" to "25", "q" to "1762", "after" to "cur"), api.calls.last())
        repo.items(914, "", null)
        assertEquals(mapOf("store" to "914", "limit" to "25"), api.calls.last().second)
        repo.item(914, "176255"); assertEquals("/v1/agents/m/retrace/item/914/176255", api.calls.last().first)
        repo.label(914, "B-12/3 4"); assertEquals("/v1/agents/m/retrace/label/914/B-12%2F3%204", api.calls.last().first)
        repo.pos(326, "c2"); assertEquals("/v1/agents/m/retrace/pos" to mapOf("store" to "326", "limit" to "25", "after" to "c2"), api.calls.last())
    }

    @Test fun olderTrackerNotFoundIsAServerFailureAndGarbageIsToo() = runBlocking {
        api.fail({ _, _ -> true }, ApiResult.Failure(ApiError.NotFound, 404, "no such route"))
        val f = RetraceRepository(api).items(914, null, null) as ApiResult.Failure
        assertEquals(ApiError.Server, f.error); assertEquals(Problem.Server, retraceProblem(ApiResult.Failure(ApiError.NotFound, 404)))
        api.routes.clear(); api.on({ _, _ -> true }, """{"items":"nope"}""")
        assertEquals(ApiError.Server, (RetraceRepository(api).items(914, null, null) as ApiResult.Failure).error)
        assertEquals("Couldn't load", problemText(Problem.Server))
    }

    // ---- home view model -----------------------------------------------------------------------------------------------------

    @Test fun defaultsToTheStoreChosenOnWorkOrdersElseTheFirst() = runTest {
        api.on(items, RetraceFixtures.ITEMS)
        assertEquals(326, vm(saved = 326).state.value.store)
        assertEquals("saved store the phone is not approved for: the first", 914, vm(saved = 536).state.value.store)
        assertEquals("all stores saved: the first", 914, vm(saved = null).state.value.store)
        assertEquals("326", api.calls.first { it.second["store"] == "326" }.second["store"])
    }

    @Test fun listsItemsWithAsOfAndPages() = runTest {
        api.on({ p, q -> p.endsWith("/items") && q["after"] == null }, RetraceFixtures.ITEMS)
        val vm = vm()
        val s = vm.state.value
        assertEquals(LoadView.Ok, s.load); assertEquals(listOf("176255", "180001"), s.items.map { it.item }); assertEquals("2026-11-14T00:36:03.192Z", s.asOf); assertTrue(s.hasMore)
        assertNull("no q when the search is empty", api.calls.last().second["q"])
        api.on({ p, q -> p.endsWith("/items") && q["after"] != null }, RetraceFixtures.ITEMS_LAST)
        vm.loadMore()
        assertEquals(listOf("176255", "180001", "190002"), vm.state.value.items.map { it.item }); assertFalse(vm.state.value.hasMore)
        assertTrue(api.calls.last().second["after"]!!.startsWith("eyJhdCI6"))
    }

    @Test fun searchSendsQAndShowsTheLabelJump() = runTest {
        api.on(items, RetraceFixtures.ITEMS)
        val vm = vm()
        api.on({ p, q -> p.endsWith("/items") && q["q"] == "176255-0000514371" }, RetraceFixtures.ITEMS_LABEL_JUMP)
        vm.setQuery("176255-0000514371")
        assertEquals("176255-0000514371", api.calls.last().second["q"])
        assertEquals(listOf("176255-0000514371"), vm.state.value.labels.map { it.label }); assertTrue(vm.state.value.items.isEmpty())
        vm.clearQuery()
        assertTrue(vm.state.value.labels.isEmpty()); assertEquals(2, vm.state.value.items.size)
    }

    @Test fun purchaseOrdersViewAndStoreSwitch() = runTest {
        api.on(items, RetraceFixtures.ITEMS); api.on(pos, RetraceFixtures.POS)
        val vm = vm()
        vm.pickView(RetraceView.PurchaseOrders)
        assertEquals(3, vm.state.value.pos.size); assertTrue(vm.state.value.items.isEmpty()); assertEquals("914", api.calls.last().second["store"])
        vm.pickStore(326)
        assertEquals("326", api.calls.last().second["store"]); assertTrue(api.calls.last().first.endsWith("/pos"))
        vm.pickView(RetraceView.Items)
        assertTrue(api.calls.last().first.endsWith("/items")); assertEquals(RetraceView.Items, vm.state.value.view)
    }

    @Test fun errorStatesAndOfflineKeepsTheList() = runTest {
        api.fail(items, ApiResult.Failure(ApiError.NotFound, 404, "no such route"))
        val old = vm().state.value
        assertEquals(LoadView.Error, old.load); assertEquals(Problem.Server, old.problem)   // a tracker that predates Retrace: the generic state
        api.routes.clear(); api.fail(items, ApiResult.Failure(ApiError.Forbidden, 403, "not your store"))
        assertEquals(Problem.Forbidden, vm().state.value.problem)
        api.routes.clear(); api.on(items, RetraceFixtures.ITEMS)
        val vm = vm()
        api.routes.clear(); api.fail(items, ApiResult.Failure(ApiError.Offline))
        vm.refresh()
        assertEquals(LoadView.Ok, vm.state.value.load); assertEquals(Problem.Offline, vm.state.value.problem); assertEquals(2, vm.state.value.items.size)
        api.routes.clear(); api.fail(pos, ApiResult.Failure(ApiError.Server, 400, "x"))
        vm.pickView(RetraceView.PurchaseOrders)
        assertEquals(LoadView.Error, vm.state.value.load)
    }

    // ---- detail view model ---------------------------------------------------------------------------------------------------

    @Test fun itemAndLabelDetails() = runTest {
        api.on({ p, _ -> p == "/v1/agents/m/retrace/item/914/176255" }, RetraceFixtures.ITEM)
        api.on({ p, _ -> p == "/v1/agents/m/retrace/label/914/176255-0000514371" }, RetraceFixtures.LABEL)
        val item = RetraceDetailViewModel(RetraceRepository(api), TestAuth(), RtTarget.Item(914, "176255"))
        assertEquals(LoadView.Ok, item.item.value.view); assertEquals("Galaxy S23 screen", item.item.value.data!!.info!!.name); assertEquals("Sandbox #914", item.item.value.storeName(914))
        val label = RetraceDetailViewModel(RetraceRepository(api), TestAuth(), RtTarget.Label(914, "176255-0000514371"))
        assertEquals("7000010", label.label.value.data!!.row!!.wo)
    }

    @Test fun detailNotFoundIsTheGenericErrorAndRetryReloads() = runTest {
        api.fail({ p, _ -> p.contains("/retrace/item/") }, ApiResult.Failure(ApiError.NotFound, 404, "item not seen at this store"))
        val vm = RetraceDetailViewModel(RetraceRepository(api), TestAuth(), RtTarget.Item(914, "999"))
        assertEquals(LoadView.Error, vm.item.value.view); assertEquals(Problem.Server, vm.item.value.problem)
        api.routes.clear(); api.on({ p, _ -> p.contains("/retrace/item/") }, RetraceFixtures.ITEM)
        vm.refresh()
        assertEquals(LoadView.Ok, vm.item.value.view)
    }
}
