package dev.aethernet.linkpearl.feature.alerts

import dev.aethernet.linkpearl.core.data.ApiError
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AlertCheckerTest {
    private val names = mapOf(914 to "Sandbox Store", 326 to "Lynnhaven")

    private class Rig(handler: (String, String, Map<String, String>, JsonElement?) -> dev.aethernet.linkpearl.core.data.ApiResult<JsonElement>, cursor: Int?, allowed: Boolean = true) {
        val api = FakeApi(handler)
        val state = MemoryCheckState(cursor)
        val notifier = FakeNotifier(allowed)
        var authRefreshes = 0
        var unread = -1
        val checker = AlertChecker(
            AlertsRemote(api), state, notifier, storeNames = { mapOf(914 to "Sandbox Store", 326 to "Lynnhaven") },
            refreshAuth = { authRefreshes++ }, onUnread = { unread = it }, now = { 1234L },
        )
    }

    private fun feedAnswer(unread: Int = 2) = buildJsonObject { put("v", 1); put("cursor", 412); put("unread", unread); put("more", false); put("alerts", JsonArray(emptyList())) }

    /** A server that follows the contract: entries are those with id > since, oldest first; the feed answers the unread count. */
    private fun server(entries: List<JsonObject>, cursor: Int = 412) = { _: String, path: String, q: Map<String, String>, _: JsonElement? ->
        when {
            path.endsWith("/alerts/new") -> {
                val since = q["since"]?.toInt()
                if (since == null) ok(buildJsonObject { put("v", 1); put("cursor", cursor); put("alerts", JsonArray(emptyList())) })
                else ok(buildJsonObject {
                    put("v", 1); put("cursor", cursor)
                    put("alerts", JsonArray(entries.filter { (it["id"] as JsonPrimitive).content.toInt() > since }))
                })
            }
            else -> ok(feedAnswer())
        }
    }

    @Test fun firstRunStoresTheCursorAndNotifiesNothing() = runTest {
        val rig = Rig(server(listOf(Contract.stuck700000014)), cursor = null)
        assertEquals(CheckOutcome.Done, rig.checker.run())
        assertEquals(412, rig.state.cursorValue)
        assertTrue(rig.notifier.posted.isEmpty())
        // first run asks without `since`
        assertNull((rig.api.calls.first { (it[1] as String).endsWith("/alerts/new") }[2] as Map<*, *>)["since"])
        assertEquals(1234L, rig.state.last)
    }

    @Test fun newAlertsAreNotifiedThenTheCursorMoves() = runTest {
        val alerts = (Contract.poll["alerts"] as JsonArray).map { it as JsonObject }
        val rig = Rig(server(alerts), cursor = 398)
        rig.checker.run()
        assertEquals(listOf(411, 412), rig.notifier.posted.map { it.id })
        assertEquals("Lynnhaven", rig.notifier.posted[0].title)
        assertEquals("No updates from Lynnhaven since 1:40 PM (store hours)", rig.notifier.posted[0].text)
        assertEquals("Work order 401 has been in Diagnostics for 3 days", rig.notifier.posted[1].text)
        assertEquals(401L, rig.notifier.posted[1].workOrder)
        assertEquals(412, rig.state.cursorValue)
        assertEquals(2, rig.unread)
    }

    @Test fun duplicatePollDoesNotNotifyTwice() = runTest {
        val alerts = (Contract.poll["alerts"] as JsonArray).map { it as JsonObject }
        val rig = Rig(server(alerts), cursor = 398)
        rig.checker.run()
        rig.checker.run()
        assertEquals(2, rig.notifier.posted.size)
    }

    @Test fun heldKeepsTheCursor() = runTest {
        val rig = Rig({ _, path, _, _ -> if (path.endsWith("/alerts/new")) ok(Contract.held) else ok(feedAnswer()) }, cursor = 398)
        rig.checker.run()
        assertEquals(398, rig.state.cursorValue)
        assertTrue(rig.notifier.posted.isEmpty())
    }

    @Test fun moreKeepsPollingFromTheNewCursor() = runTest {
        val pages = mutableListOf<Int?>()
        val rig = Rig({ _, path, q, _ ->
            if (path.endsWith("/alerts/new")) {
                val since = q["since"]!!.toInt(); pages += since
                if (since == 100) ok(buildJsonObject { put("v", 1); put("cursor", 150); put("more", true); put("alerts", JsonArray(listOf(Contract.stuck700000014))) })
                else ok(buildJsonObject { put("v", 1); put("cursor", 160); put("alerts", JsonArray(listOf(Contract.followup))) })
            } else ok(feedAnswer())
        }, cursor = 100)
        rig.checker.run()
        assertEquals(listOf<Int?>(100, 150), pages)
        assertEquals(2, rig.notifier.posted.size)
        assertEquals(160, rig.state.cursorValue)
    }

    @Test fun serverErrorLeavesTheCursorAndAsksForARetry() = runTest {
        val rig = Rig({ _, _, _, _ -> fail(ApiError.Server) }, cursor = 398)
        assertEquals(CheckOutcome.Retry, rig.checker.run(attempt = 0))
        assertEquals(398, rig.state.cursorValue)
        // never loops forever: after the allowed retries it just waits for the next period
        assertEquals(CheckOutcome.Done, rig.checker.run(attempt = AlertChecker.MAX_RETRIES))
        assertEquals(398, rig.state.cursorValue)
    }

    @Test fun offlineRetriesRateLimitWaits() = runTest {
        assertEquals(CheckOutcome.Retry, Rig({ _, _, _, _ -> fail(ApiError.Offline) }, 1).checker.run())
        assertEquals(CheckOutcome.Done, Rig({ _, _, _, _ -> fail(ApiError.RateLimited) }, 1).checker.run())
    }

    @Test fun unauthorizedTellsAuthAndStopsQuietly() = runTest {
        val rig = Rig({ _, _, _, _ -> fail(ApiError.Unauthorized) }, cursor = 398)
        assertEquals(CheckOutcome.Done, rig.checker.run())
        assertEquals(1, rig.authRefreshes)
        val rig2 = Rig({ _, _, _, _ -> fail(ApiError.Forbidden) }, cursor = 398)
        assertEquals(CheckOutcome.Done, rig2.checker.run())
        assertEquals(1, rig2.authRefreshes)
        assertEquals(398, rig2.state.cursorValue)
    }

    @Test fun aFailedPostLeavesTheCursor() = runTest {
        val alerts = (Contract.poll["alerts"] as JsonArray).map { it as JsonObject }
        val rig = Rig(server(alerts), cursor = 398)
        rig.notifier.postWorks = false
        rig.checker.run()
        assertEquals(398, rig.state.cursorValue)
    }

    @Test fun notificationsOffKeepsTheCursorButRefreshesTheBadge() = runTest {
        val alerts = (Contract.poll["alerts"] as JsonArray).map { it as JsonObject }
        val rig = Rig(server(alerts), cursor = 398, allowed = false)
        rig.checker.run()
        assertTrue(rig.notifier.posted.isEmpty())
        assertEquals(398, rig.state.cursorValue)
        assertEquals(2, rig.unread)
    }

    @Test fun cursorMovesPastEntriesThatDoNotQualify() = runTest {
        val rig = Rig({ _, path, _, _ -> if (path.endsWith("/alerts/new")) ok(buildJsonObject { put("v", 1); put("cursor", 420); put("alerts", JsonArray(emptyList())) }) else ok(feedAnswer(0)) }, cursor = 398)
        rig.checker.run()
        assertEquals(420, rig.state.cursorValue)
    }

    @Test fun noCustomerDataInNotes() = runTest {
        val rig = Rig(server(listOf(Contract.stuck700000014, Contract.pickup, Contract.followup, Contract.back)), cursor = 1)
        rig.checker.run()
        // `back` never notifies; every other note is the store as title and the contract sentence as text
        assertEquals(listOf("Sandbox Store"), rig.notifier.posted.map { it.title }.distinct())
        assertEquals(3, rig.notifier.posted.size)
    }
}
