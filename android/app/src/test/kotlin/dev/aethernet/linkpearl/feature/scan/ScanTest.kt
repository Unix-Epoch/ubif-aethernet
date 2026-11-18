package dev.aethernet.linkpearl.feature.scan

import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.feature.retrace.RetraceFixtures
import dev.aethernet.linkpearl.feature.retrace.RetraceRepository
import dev.aethernet.linkpearl.feature.workorders.FakeApi
import dev.aethernet.linkpearl.feature.workorders.MemoryWoStorePreference
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/** The general scanner: which codes open what, and the store a label is found in. */
@OptIn(ExperimentalCoroutinesApi::class)
class ScanTest {
    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    private val api = FakeApi()
    private fun vm(saved: Int? = null, stores: List<Int> = listOf(914, 915)) = ScanViewModel(RetraceRepository(api), stores, MemoryWoStorePreference(saved))
    private fun labelAt(store: Int) = { p: String, _: Map<String, String> -> p.startsWith("/v1/agents/m/retrace/label/$store/") }

    @Test fun parsesWorkOrdersAndLabels() {
        assertEquals(ScanTarget.WorkOrder("123456789"), ScanCode.parse(" 123456789 "))
        assertEquals(ScanTarget.Label("176255-0000514371"), ScanCode.parse("176255-0000514371"))
        assertEquals(ScanTarget.Label("B-542070-12345"), ScanCode.parse("b-542070-12345"))
        assertNull(ScanCode.parse("1234"))
        assertNull(ScanCode.parse("hello"))
        assertNull(ScanCode.parse("176255-ABC"))
        assertNull(ScanCode.parse(null))
    }

    @Test fun storeOrderPutsTheRememberedStoreFirst() {
        assertEquals(listOf(915, 914), ScanCode.storeOrder(915, listOf(914, 915)))
        assertEquals(listOf(914, 915), ScanCode.storeOrder(null, listOf(914, 915)))
        assertEquals(listOf(914, 915), ScanCode.storeOrder(999, listOf(914, 915)))
    }

    @Test fun workOrderOpensAtOnce() {
        val v = vm()
        v.onCode("123456789")
        assertEquals("workorders/123456789", v.state.value.open)
        assertEquals(0, api.calls.size)
        v.opened(); assertNull(v.state.value.open)
    }

    @Test fun labelOpensInTheFirstStoreThatKnowsIt() {
        api.on(labelAt(915), RetraceFixtures.LABEL)
        val v = vm()
        v.onCode("176255-0000514371")
        assertEquals("retrace/label/915/176255-0000514371", v.state.value.open)
        assertEquals(listOf("/v1/agents/m/retrace/label/914/176255-0000514371", "/v1/agents/m/retrace/label/915/176255-0000514371"), api.calls.map { it.first })
    }

    @Test fun rememberedStoreIsTriedFirst() {
        api.on({ _, _ -> true }, RetraceFixtures.LABEL)
        val v = vm(saved = 915)
        v.onCode("176255-0000514371")
        assertEquals("retrace/label/915/176255-0000514371", v.state.value.open)
        assertEquals(1, api.calls.size)
    }

    @Test fun unknownLabelAndOtherCodesSayWhy() {
        val v = vm()
        v.onCode("176255-0000514371")
        assertNull(v.state.value.open); assertEquals("176255-0000514371 not found", v.state.value.message)
        v.onCode("hello")
        assertEquals(ScanViewModel.NOT_A_LABEL, v.state.value.message)
        api.fail({ _, _ -> true }, ApiResult.Failure(ApiError.Offline))
        v.onCode("176255-0000514371")
        assertEquals("Couldn't load", v.state.value.message)
    }
}
