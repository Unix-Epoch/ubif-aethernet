package dev.aethernet.linkpearl.feature.workorders

import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.lock.TestAuth
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WorkOrderDetailViewModelTest {
    private val main = UnconfinedTestDispatcher()
    @Before fun setUp() = Dispatchers.setMain(main)
    @After fun tearDown() = Dispatchers.resetMain()

    private val api = FakeApi()
    private fun vm(lock: FakeAppLock) = WorkOrderDetailViewModel(WoRepository(api), lock, TestAuth(), nowMs = { 0L }, work = main)

    @Test fun lockedDetailIsPlain() = runTest {
        api.on({ p, _ -> p == "/v1/agents/m/wo/914/7000003" }, WoFixtures.DETAIL)
        val vm = vm(FakeAppLock())
        vm.show(WoKey(914, 7000003))
        val s = vm.state.value
        assertEquals(LoadView.Ok, s.view)
        assertEquals(SealedUi.Locked, s.sealed)
        assertTrue(api.calls.single().second.isEmpty())
        assertEquals(2, s.detail!!.timeline.size)
        assertEquals("Diagnostics", s.detail!!.timeline[1].status)
        assertEquals(2, s.detail!!.cart!!.lines.size)
        assertEquals("Sandbox #914", s.storeName(914))
    }

    @Test fun unlockedDetailOpensCardAndSnapshot() = runTest {
        api.on({ p, q -> p == "/v1/agents/m/wo/914/700000123" && q["sealed"] == "1" }, WoFixtures.DETAIL_VECTOR_SEALED)
        val vm = vm(FakeAppLock(unlocked = true))
        vm.show(WoKey(914, 700000123))
        val u = (vm.state.value.sealed as SealedUi.Shown).data
        assertEquals("Sam Sample", u.name)
        assertEquals(listOf("5555550123"), u.phones)
        assertEquals(listOf("sam.sample@example.com"), u.emails)
        assertEquals("490154203237518", u.imei)
        assertEquals("F2LTESTSERIAL", u.serial)
        assertEquals(listOf("Customer asked for a text when it is ready.", "Test Tech started Diagnostics."), u.notes.map { it.text })
        assertEquals(listOf(NoteKind.Manual, NoteKind.Automatic), u.notes.map { it.kind })
        assertEquals("Test T.", u.notes[0].author)
        assertEquals(2, u.notesTotal)
        assertEquals("2026-11-13T17:02:23.485Z", u.fetchedAt)
        assertNull("sealed blobs are not kept in state", vm.state.value.detail!!.sealed)
    }

    @Test fun lockingDropsTheCustomerAndUnlockingRefetchesSealed() = runTest {
        api.on({ p, _ -> p == "/v1/agents/m/wo/914/700000123" }, WoFixtures.DETAIL.replace("\"wo\":7000003", "\"wo\":700000123"))
        api.on({ p, q -> p == "/v1/agents/m/wo/914/700000123" && q["sealed"] == "1" }, WoFixtures.DETAIL_VECTOR_SEALED)
        val lock = FakeAppLock()
        val vm = vm(lock)
        vm.show(WoKey(914, 700000123))
        assertEquals(SealedUi.Locked, vm.state.value.sealed)
        lock.unlock()
        assertTrue(vm.state.value.sealed is SealedUi.Shown)
        assertEquals("1", api.calls.last().second["sealed"])
        lock.lock()
        assertEquals(SealedUi.Locked, vm.state.value.sealed)
    }

    @Test fun storeWithoutKeyShowsNoKey() = runTest {
        api.on({ p, _ -> p == "/v1/agents/m/wo/326/7000003" }, WoFixtures.DETAIL.replace("\"store\":914", "\"store\":326"))
        val vm = vm(FakeAppLock(unlocked = true))
        vm.show(WoKey(326, 7000003))
        assertEquals(SealedUi.NoKey, vm.state.value.sealed)
        assertTrue("never asks for sealed without a key", api.calls.none { it.second["sealed"] == "1" })
    }

    @Test fun serverNoKeyAnswerFallsBackToPlain() = runTest {
        api.on({ p, _ -> p == "/v1/agents/m/wo/914/7000003" }, WoFixtures.DETAIL)
        api.fail({ _, q -> q["sealed"] == "1" }, ApiResult.Failure(ApiError.Forbidden, 403, "no key for this store"))
        val vm = vm(FakeAppLock(unlocked = true))
        vm.show(WoKey(914, 7000003))
        assertEquals(LoadView.Ok, vm.state.value.view)
        assertEquals(SealedUi.NoKey, vm.state.value.sealed)
    }

    @Test fun missingSealedPartsAndWrongBlobs() = runTest {
        api.on({ _, q -> q["sealed"] == "1" }, WoFixtures.DETAIL.trimEnd().removeSuffix("}") + ""","sealed":{"card":null,"snapshot":null}}""")
        val vm = vm(FakeAppLock(unlocked = true))
        vm.show(WoKey(914, 7000003))
        assertEquals(SealedUi.Missing, vm.state.value.sealed)
        // the vector's blobs presented for another work order fail the GCM tag: shown as a failure, no crash
        api.on({ _, q -> q["sealed"] == "1" }, WoFixtures.DETAIL_VECTOR_SEALED.replace("\"wo\":700000123", "\"wo\":7000004"))
        vm.show(WoKey(914, 7000004))
        assertEquals(SealedUi.Failed, vm.state.value.sealed)
    }

    @Test fun notFoundAndOffline() = runTest {
        api.fail({ _, _ -> true }, ApiResult.Failure(ApiError.NotFound, 404, "no such work order"))
        val vm = vm(FakeAppLock())
        vm.show(WoKey(914, 1))
        assertEquals(LoadView.Error, vm.state.value.view)
        assertEquals(Problem.NotFound, vm.state.value.problem)
        api.on({ _, _ -> true }, WoFixtures.DETAIL)
        vm.show(WoKey(914, 7000003))
        api.fail({ _, _ -> true }, ApiResult.Failure(ApiError.Offline))
        vm.refresh()
        assertEquals(LoadView.Ok, vm.state.value.view)
        assertEquals(Problem.Offline, vm.state.value.problem)
    }
}
