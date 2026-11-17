package dev.aethernet.linkpearl.feature.prices

import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.data.LinkpearlJson
import dev.aethernet.linkpearl.core.lock.TestAuth
import dev.aethernet.linkpearl.feature.alerts.FakeApi
import dev.aethernet.linkpearl.feature.workorders.LoadView
import dev.aethernet.linkpearl.feature.workorders.Problem
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Prices: lenient parsing of the documented answers, the local filter, the words, the repository and the view model. */
@OptIn(ExperimentalCoroutinesApi::class)
class PricesTest {
    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    // The examples in tracker-worker/MOBILE-API-prices.md (invented sheet).
    private val DEVICES = """{"store":914,"syncedAt":"2026-11-14T13:00:00.000Z",
 "devices":[{"key":"iphone15promax","name":"iPhone 15 Pro Max","tab":"Apple"},{"key":"iphone15pro","name":"iPhone 15 Pro","tab":"Apple"},
            {"key":"iphone15","name":"iPhone 15","tab":"Apple"},
            {"key":"iphone6","name":"iPhone 6","tab":"Apple"},{"key":"iphone6s","name":"iPhone 6S","tab":"Apple"},
            {"key":"zfold5","name":"Galaxy Z Fold 5","tab":"Samsung"},{"key":"ipad9thgen","name":"iPad 9th Gen (10.2)","tab":"ipad"},
            {"key":"ps5","name":"Sony PS5","tab":"Game Console"}]}"""
    private val PRO = """{"store":914,"syncedAt":"2026-11-14T13:00:00.000Z",
 "matches":[{"name":"iPhone 15 Pro","tab":"Apple","variant":null,
   "repairs":[{"repair":"Screen","label":"Screen","price":329.99,"raw":"$329.99"},
              {"repair":"Screen","label":"OEM","price":null,"raw":"N/A"},
              {"repair":"Battery","label":"Battery","price":null,"raw":"Apple self repair"},
              {"repair":"Charge port","label":"Charging Port","price":149.99,"raw":"$149.99"},
              {"repair":"Back glass","label":"Back Glass","price":190,"raw":"$190 (MS)"}]}]}"""
    private val FOLD = """{"store":914,"syncedAt":"2026-11-14T13:00:00.000Z",
 "matches":[{"name":"Galaxy Z Fold 5 Inner","tab":"Samsung","variant":"inner","repairs":[{"repair":"Screen","label":"OLED","price":549.99,"raw":"$549.99"},{"repair":"Battery","label":"Battery","price":129.99,"raw":"$129.99"}]},
            {"name":"Galaxy Z Fold 5 Outer","tab":"Samsung","variant":"outer","repairs":[{"repair":"Screen","label":"OLED","price":219.99,"raw":"$219.99"}]}]}"""

    private fun json(s: String) = LinkpearlJson.parseToJsonElement(s)

    @Test fun parsesTheDeviceList() {
        val d = PriceParse.devices(json(DEVICES))
        assertEquals(914, d.store); assertEquals("2026-11-14T13:00:00.000Z", d.syncedAt); assertEquals(8, d.devices.size)
        assertEquals(PriceDevice("iphone15pro", "iPhone 15 Pro", "Apple"), d.devices[1])
        val none = PriceParse.devices(json("""{"store":326,"syncedAt":null,"devices":[]}"""))
        assertNull(none.syncedAt); assertTrue(none.devices.isEmpty())
    }

    @Test fun parsesPricesWithLabelsRawAndDashes() {
        val m = PriceParse.matches(json(PRO)).matches.single()
        assertEquals(listOf("Screen", "OEM", "Battery", "Charging Port", "Back Glass"), m.repairs.map { it.title })
        assertEquals(listOf("$329.99", "—", "Apple self repair", "$149.99", "$190"), m.repairs.map { it.shown })
        assertNull(m.variant); assertEquals("iPhone 15 Pro", m.chipLabel)
    }

    @Test fun foldHalvesAreLabelled() {
        val f = PriceParse.matches(json(FOLD)).matches
        assertEquals(listOf("Galaxy Z Fold 5 · Inner", "Galaxy Z Fold 5 · Outer"), f.map { it.chipLabel })
    }

    @Test fun lenient() {
        // Unknown keys, missing keys, numbers as text, a store as text, a broken entry: none of it throws.
        val m = PriceParse.matches(json("""{"store":"914","extra":{"a":1},"matches":[{"name":"X","repairs":[{"label":"Screen","price":"$1,249.50"},{"repair":"Battery"},7]},"junk"]}"""))
        assertEquals(914, m.store); assertNull(m.syncedAt)
        assertEquals(listOf("Screen", "Battery"), m.matches.single().repairs.map { it.title })
        assertEquals(listOf("$1,249.50", "—"), m.matches.single().repairs.map { it.shown })
        assertTrue(PriceParse.devices(json("[]")).devices.isEmpty())
        assertTrue(PriceParse.matches(json("""{"matches":null}""")).matches.isEmpty())
        assertEquals(listOf("only key"), PriceParse.devices(json("""{"devices":[{"key":"only key"},{"tab":"Apple"}]}""")).devices.map { it.name })
    }

    @Test fun filterMatchesEveryWordShortestFirst() {
        val all = PriceParse.devices(json(DEVICES)).devices
        assertEquals(listOf("iPhone 15 Pro", "iPhone 15 Pro Max"), PriceFmt.filter(all, "15 pro").map { it.name })
        assertEquals(listOf("iPhone 6", "iPhone 6S"), PriceFmt.filter(all, "IPHONE 6").map { it.name })
        assertEquals(listOf("Galaxy Z Fold 5"), PriceFmt.filter(all, "zfold").map { it.name })
        assertTrue(PriceFmt.filter(all, "  ").isEmpty()); assertTrue(PriceFmt.filter(all, "pixel").isEmpty())
        assertEquals(2, PriceFmt.filter(all, "iphone", limit = 2).size)
    }

    @Test fun moneyAndShareText() {
        assertEquals("$190", PriceFmt.money(190.0)); assertEquals("$329.99", PriceFmt.money(329.99)); assertEquals("$1,049.50", PriceFmt.money(1049.5))
        assertFalse(PriceFmt.meaningful("N/A")); assertFalse(PriceFmt.meaningful(" ")); assertTrue(PriceFmt.meaningful("Apple self repair"))
        val m = PriceParse.matches(json(PRO)).matches
        assertEquals("iPhone 15 Pro\nScreen: $329.99\nOEM: —\nBattery: Apple self repair\nCharging Port: $149.99\nBack Glass: $190", PriceFmt.shareText(m))
    }

    @Test fun repositoryKeepsTheListUntilFreshOrResynced() = runBlocking {
        var synced = "2026-11-14T13:00:00.000Z"
        val api = FakeApi { _, _, q, _ -> ApiResult.Success(json(if (q["q"] == null) DEVICES else PRO.replace("2026-11-14T13:00:00.000Z", synced))) }
        val repo = RealPricesRepository(api)
        repo.devices(914); repo.devices(914)
        assertEquals(1, api.calls.size)
        assertEquals(mapOf("store" to "914"), api.calls[0][2])
        repo.prices(914, " iphone15pro ")
        assertEquals(mapOf("store" to "914", "q" to "iphone15pro"), api.calls[1][2])
        repo.devices(914); assertEquals(2, api.calls.size)
        synced = "2026-11-15T13:00:00.000Z"
        repo.prices(914, "iphone15pro"); repo.devices(914)
        assertEquals("a new syncedAt drops the kept list", 4, api.calls.size)
        repo.devices(914, fresh = true); assertEquals(5, api.calls.size)
        val nf = RealPricesRepository(FakeApi { _, _, _, _ -> ApiResult.Failure(ApiError.NotFound, 404) }).devices(914)
        assertEquals(ApiError.Server, (nf as ApiResult.Failure).error)
    }

    // ---- view model ---------------------------------------------------------------------------------------------------------

    private fun vm(repo: FakePricesRepository = FakePricesRepository(), store: Int? = FakePrices.STORE) =
        PricesViewModel(repo, TestAuth(dev.aethernet.linkpearl.core.data.AuthState.Registered("Fold", listOf(
            dev.aethernet.linkpearl.core.data.StoreRef(999999, "Sandbox"), dev.aethernet.linkpearl.core.data.StoreRef(326, "Lynnhaven")))), store, debounceMs = 0)

    @Test fun typingFiltersLocallyAndAsksForTheFirstMatch() {
        val repo = FakePricesRepository()
        val m = vm(repo)
        assertEquals(listOf(999999), repo.deviceCalls); assertEquals(LoadView.Ok, m.state.value.list); assertNull(m.state.value.prices)
        m.setQuery("15 pro")
        val s = m.state.value
        assertEquals(listOf("iPhone 15 Pro", "iPhone 15 Pro Max"), s.shown.map { it.name })
        assertEquals("iphone15pro", s.chosen!!.key); assertEquals(999999 to "iphone15pro", repo.priceCalls.single())
        assertEquals(LoadView.Ok, s.prices); assertEquals("iPhone 15 Pro", s.match!!.name)
        m.setQuery("15 pro ")
        assertEquals("the same choice is not asked again", 1, repo.priceCalls.size)
        m.choose(s.shown[1]); assertEquals("iphone15promax", repo.priceCalls.last().second)
        m.setQuery("15 pro max"); assertEquals(2, repo.priceCalls.size)
        m.setQuery("zzz"); assertTrue(m.state.value.shown.isEmpty()); assertNull(m.state.value.chosen); assertNull(m.state.value.prices)
        m.clearQuery(); assertEquals("", m.state.value.query)
    }

    @Test fun aFoldGivesTwoMatchesToPickFrom() {
        val m = vm()
        m.setQuery("fold")
        assertEquals(2, m.state.value.matches.size); assertEquals("Galaxy Z Fold 5 Inner", m.state.value.match!!.name)
        m.pickMatch(1); assertEquals("Galaxy Z Fold 5 Outer", m.state.value.match!!.name)
        m.pickMatch(9); assertEquals(1, m.state.value.matchIndex)
    }

    @Test fun storeWithoutASheet() {
        val m = vm(store = 326)
        assertTrue(m.state.value.noSheet)
        m.setQuery("iphone"); assertTrue(m.state.value.shown.isEmpty())
    }

    @Test fun allStoresOpensOnTheFirstStoreAndStoresSwitch() {
        val repo = FakePricesRepository()
        val m = vm(repo, store = null)
        assertEquals(999999, m.state.value.store)
        m.setQuery("15 pro")
        m.pickStore(326)
        assertEquals(listOf(999999, 326), repo.deviceCalls); assertTrue(m.state.value.noSheet); assertNull(m.state.value.chosen)
        assertEquals("Lynnhaven #326", m.state.value.storeLabel())
    }

    @Test fun failures() {
        val repo = FakePricesRepository(devicesAnswer = { ApiResult.Failure(ApiError.Offline) })
        val m = vm(repo)
        assertEquals(LoadView.Error, m.state.value.list); assertEquals(Problem.Offline, m.state.value.problem)
        repo.devicesAnswer = null
        m.refresh(); assertEquals(LoadView.Ok, m.state.value.list); assertNull(m.state.value.problem)
        repo.pricesAnswer = { _, _ -> ApiResult.Failure(ApiError.Server, 500) }
        m.setQuery("15 pro"); assertEquals(LoadView.Error, m.state.value.prices); assertEquals(Problem.Server, m.state.value.problem)
        repo.pricesAnswer = null
        m.refresh(); assertEquals(LoadView.Ok, m.state.value.prices)
    }
}
