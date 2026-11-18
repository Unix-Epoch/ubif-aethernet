package dev.aethernet.linkpearl.feature.scanner

import com.google.mlkit.vision.barcode.common.Barcode
import dev.aethernet.linkpearl.core.data.LinkpearlJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
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
class ScannerTest {
    private val main = StandardTestDispatcher()
    @Before fun setUp() = Dispatchers.setMain(main)
    @After fun tearDown() = Dispatchers.resetMain()

    private var now = 10_000L
    private fun gate(t: ScanTuning) = ScanGate({ t }, { now })

    @Test fun kindFollowsTheFormats() {
        assertEquals(ScanKind.Qr, ScanKind.of(listOf(Barcode.FORMAT_QR_CODE)))
        assertEquals(ScanKind.Labels, ScanKind.of(listOf(Barcode.FORMAT_CODE_128, Barcode.FORMAT_CODE_39)))
    }

    @Test fun holdOnePassesTheFirstReadThenWaitsTheRepeatTime() {
        val g = gate(ScanTuning.default(ScanKind.Labels))
        assertEquals("A", g.onFrame(listOf("A")))
        now += 1000; assertNull(g.onFrame(listOf("A")))
        now += 600; assertEquals("A", g.onFrame(listOf("A")))
        assertEquals("B", g.onFrame(listOf("B")))
    }

    @Test fun holdNeedsThatManyFramesInARow() {
        val g = gate(ScanTuning.default(ScanKind.Labels).copy(hold = 3))
        assertNull(g.onFrame(listOf("A")))
        assertNull(g.onFrame(listOf("A")))
        assertEquals("A", g.onFrame(listOf("A")))
    }

    @Test fun aDifferentCodeOrAnEmptyFrameBreaksTheStreak() {
        val g = gate(ScanTuning.default(ScanKind.Labels).copy(hold = 2))
        assertNull(g.onFrame(listOf("A")))
        assertNull(g.onFrame(listOf("B")))
        assertNull(g.onFrame(emptyList()))
        assertNull(g.onFrame(listOf("B")))
        assertEquals("B", g.onFrame(listOf("B")))
    }

    @Test fun theFirstCodeOfAFrameIsTheOneCounted() {
        val g = gate(ScanTuning.default(ScanKind.Labels))
        assertEquals("X", g.onFrame(listOf("X", "Y")))
    }

    @Test fun areaIsClampedAndHasAMinimumSize() {
        val a = ScanArea(-0.2f, 0.5f, 0.05f, 1.4f).clamped()
        assertEquals(0f, a.left)
        assertEquals(ScanArea.MIN, a.right, 1e-6f)
        assertEquals(1f, a.bottom)
        assertTrue(a.contains(0.05f, 0.7f))
        assertFalse(a.contains(0.5f, 0.7f))
    }

    @Test fun tuningIsClampedToItsRanges() {
        val t = ScanTuning.default(ScanKind.Qr).copy(zoom = 9f, hold = 0, repeatMs = 50).clamped()
        assertEquals(ScanTuning.ZOOM_MAX, t.zoom)
        assertEquals(ScanTuning.HOLD_MIN, t.hold)
        assertEquals(ScanTuning.REPEAT_MIN, t.repeatMs)
    }

    @Test fun defaultsMatchTheOldScanner() {
        val t = ScanTuning.default(ScanKind.Labels)
        assertEquals(1, t.hold); assertEquals(1500L, t.repeatMs); assertEquals(1f, t.zoom)
        assertFalse(t.light || t.vibrate || t.sound)
    }

    @Test fun tuningRoundTripsAsJson() {
        val t = ScanTuning(ScanArea(0.1f, 0.2f, 0.8f, 0.6f), zoom = 1.6f, hold = 2, repeatMs = 2000, light = true, vibrate = true)
        assertEquals(t, LinkpearlJson.decodeFromString(ScanTuning.serializer(), LinkpearlJson.encodeToString(ScanTuning.serializer(), t)))
    }

    @Test fun viewModelLoadsChangesAndSavesAfterAPause() = runTest(main) {
        val prefs = MemoryScannerPrefs(mapOf(ScanKind.Labels to ScanTuning.default(ScanKind.Labels).copy(zoom = 2f)))
        val vm = ScannerViewModel(prefs, saveDelayMs = 300)
        advanceUntilIdle()
        assertEquals(2f, vm.state.value.tuning.zoom)
        vm.change(vm.state.value.tuning.copy(hold = 3))
        assertEquals(3, vm.state.value.tuning.hold)
        advanceTimeBy(100)
        assertEquals(1, prefs.tuning(ScanKind.Labels).first().hold)
        advanceTimeBy(300)
        assertEquals(3, prefs.tuning(ScanKind.Labels).first().hold)
    }

    @Test fun viewModelKeepsEachSetupApartAndCountsReads() = runTest(main) {
        val prefs = MemoryScannerPrefs()
        val vm = ScannerViewModel(prefs)
        advanceUntilIdle()
        vm.onCode("900101-1"); vm.onCode("900101-1")
        assertEquals("900101-1", vm.state.value.lastCode)
        assertEquals(2, vm.state.value.reads)
        vm.setArea(ScanArea(0.2f, 0.2f, 0.6f, 0.5f))
        vm.pick(ScanKind.Qr)
        advanceUntilIdle()
        assertEquals(ScanKind.Qr, vm.state.value.kind)
        assertEquals(0, vm.state.value.reads)
        assertNull(vm.state.value.lastCode)
        assertEquals(ScanTuning.default(ScanKind.Qr), vm.state.value.tuning)
        assertEquals(ScanArea(0.2f, 0.2f, 0.6f, 0.5f), prefs.tuning(ScanKind.Labels).first().area)
    }

    @Test fun resetGoesBackToTheDefaults() = runTest(main) {
        val prefs = MemoryScannerPrefs()
        val vm = ScannerViewModel(prefs)
        advanceUntilIdle()
        vm.change(vm.state.value.tuning.copy(zoom = 3f, sound = true))
        vm.reset()
        advanceUntilIdle()
        assertEquals(ScanTuning.default(ScanKind.Labels), prefs.tuning(ScanKind.Labels).first())
    }
}
