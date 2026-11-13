package dev.aethernet.linkpearl.feature.alerts

import dev.aethernet.linkpearl.core.data.ApiError
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AlertSettingsTest {
    private val bundle = parseSettings(Contract.settings)!!

    @Test fun parsesTheContractExample() {
        val s = bundle.settings
        assertEquals(TypeSetting(true, 3), s.types[AlertType.Stuck])
        assertEquals(TypeSetting(true, 7), s.types[AlertType.Pickup])
        assertEquals(TypeSetting(true, 9), s.types[AlertType.Followup])
        assertEquals(TypeSetting(true, 2), s.types[AlertType.Quiet])
        assertEquals(QuietHours(true, "22:00", "07:00"), s.quiet)
        assertEquals(mapOf(914 to true, 326 to true), s.stores)
        assertEquals(listOf(914, 326), bundle.storeIds)
        assertEquals(1..30, bundle.ranges.stuckDays); assertEquals(0..23, bundle.ranges.followupHour); assertEquals(1..12, bundle.ranges.quietHours)
    }

    @Test fun validatesAgainstTheServerRanges() {
        val s = bundle.settings; val r = bundle.ranges
        assertNull(SettingsEdit.TypeValue(AlertType.Stuck, 30).problem(s, r))
        assertEquals("Out of range", SettingsEdit.TypeValue(AlertType.Stuck, 31).problem(s, r))
        assertEquals("Out of range", SettingsEdit.TypeValue(AlertType.Stuck, 0).problem(s, r))
        assertEquals("Out of range", SettingsEdit.TypeValue(AlertType.Quiet, 13).problem(s, r))
        assertNull(SettingsEdit.TypeValue(AlertType.Followup, 0).problem(s, r))
        assertEquals("Out of range", SettingsEdit.TypeValue(AlertType.Followup, 24).problem(s, r))
        assertNull(SettingsEdit.QuietFrom("21:30").problem(s, r))
        assertEquals("Not a time", SettingsEdit.QuietFrom("9pm").problem(s, r))
        assertEquals("Not a time", SettingsEdit.QuietFrom("24:00").problem(s, r))
        assertEquals("From and to must differ", SettingsEdit.QuietFrom("07:00").problem(s, r))
        assertEquals("From and to must differ", SettingsEdit.QuietTo("22:00").problem(s, r))
    }

    @Test fun editsSerializeToTheContractPatchShape() {
        assertEquals(Json.parseToJsonElement("""{"types":{"stuck":{"days":5}}}"""), SettingsEdit.TypeValue(AlertType.Stuck, 5).json())
        assertEquals(Json.parseToJsonElement("""{"types":{"quiet":{"on":false}}}"""), SettingsEdit.TypeOn(AlertType.Quiet, false).json())
        assertEquals(Json.parseToJsonElement("""{"types":{"followup":{"hour":10}}}"""), SettingsEdit.TypeValue(AlertType.Followup, 10).json())
        assertEquals(Json.parseToJsonElement("""{"types":{"quiet":{"hours":4}}}"""), SettingsEdit.TypeValue(AlertType.Quiet, 4).json())
        assertEquals(Json.parseToJsonElement("""{"quietHours":{"from":"21:30"}}"""), SettingsEdit.QuietFrom("21:30").json())
        assertEquals(Json.parseToJsonElement("""{"stores":{"326":false}}"""), SettingsEdit.StoreOn(326, false).json())
    }

    private fun TestScope2() = CoroutineScope(UnconfinedTestDispatcher())

    @Test fun optimisticUpdateThenServerAnswerReplacesIt() = runTest {
        val api = FakeApi { m, _, _, body ->
            if (m == "GET") ok(Contract.settings) else {
                val patched = Contract.settings.toString().replace("\"days\":3", "\"days\":5")
                ok(Json.parseToJsonElement(patched))
            }
        }
        val c = AlertSettingsController(AlertsRemote(api), TestScope2())
        c.load()
        assertTrue(c.edit(SettingsEdit.TypeValue(AlertType.Stuck, 5)))
        val ready = c.state.value as SettingsUi.Ready
        assertEquals(5, ready.bundle.settings.types[AlertType.Stuck]!!.value)
        assertNull(ready.error)
        assertEquals(Json.parseToJsonElement("""{"types":{"stuck":{"days":5}}}"""), api.calls.last()[3])
    }

    @Test fun failedSaveRollsBackAndShowsOnePlainLine() = runTest {
        val api = FakeApi { m, _, _, _ -> if (m == "GET") ok(Contract.settings) else fail(ApiError.Server) }
        val c = AlertSettingsController(AlertsRemote(api), TestScope2())
        c.load()
        c.edit(SettingsEdit.TypeOn(AlertType.Pickup, false))
        val ready = c.state.value as SettingsUi.Ready
        assertTrue(ready.bundle.settings.types[AlertType.Pickup]!!.on)
        assertEquals("Couldn't save", ready.error)
        c.dismissError()
        assertNull((c.state.value as SettingsUi.Ready).error)
    }

    @Test fun rollbackTouchesOnlyTheFailedField() = runTest {
        var puts = 0
        val api = FakeApi { m, _, _, _ -> if (m == "GET") ok(Contract.settings) else { puts++; if (puts == 1) fail(ApiError.Offline) else ok(Contract.settings) } }
        val c = AlertSettingsController(AlertsRemote(api), TestScope2())
        c.load()
        c.edit(SettingsEdit.StoreOn(326, false))      // fails
        c.edit(SettingsEdit.TypeValue(AlertType.Quiet, 4)) // succeeds (server answer here is the unchanged example)
        val s = (c.state.value as SettingsUi.Ready).bundle.settings
        assertTrue(s.stores[326]!!)
    }

    @Test fun invalidEditNeverGoesOut() = runTest {
        val api = FakeApi { m, _, _, _ -> if (m == "GET") ok(Contract.settings) else fail(ApiError.Server) }
        val c = AlertSettingsController(AlertsRemote(api), TestScope2())
        c.load()
        assertFalse(c.edit(SettingsEdit.TypeValue(AlertType.Stuck, 99)))
        assertEquals(0, api.calls.count { it[0] == "PUT" })
        assertEquals(3, (c.state.value as SettingsUi.Ready).bundle.settings.types[AlertType.Stuck]!!.value)
    }

    @Test fun loadFailureIsAState() = runTest {
        val c = AlertSettingsController(AlertsRemote(FakeApi { _, _, _, _ -> fail(ApiError.Offline) }), TestScope2())
        c.load()
        assertEquals(SettingsUi.Failed(offline = true), c.state.value)
    }

    @Test fun hhmmHelpers() {
        assertEquals("07:05", toHhmm(7, 5)); assertEquals(22 to 0, hhmmParts("22:00")); assertTrue(isHhmm("00:00")); assertFalse(isHhmm("7:00"))
        assertEquals("9:00" to "AM", hourParts(9)); assertEquals("12:00" to "AM", hourParts(0)); assertEquals("12:00" to "PM", hourParts(12)); assertEquals("11:00" to "PM", hourParts(23))
    }
}
