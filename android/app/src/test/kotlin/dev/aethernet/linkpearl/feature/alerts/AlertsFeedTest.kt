package dev.aethernet.linkpearl.feature.alerts

import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.nav.TopLevel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AlertsFeedTest {
    private fun rig(api: FakeApi, cursor: Int? = null): Triple<AlertsFeed, AlertsBadges, MemoryCheckState> {
        val scope = CoroutineScope(UnconfinedTestDispatcher())
        val badge = AlertsBadges(0, scope)
        val state = MemoryCheckState(cursor)
        return Triple(AlertsFeed(AlertsRemote(api), scope, badge, state), badge, state)
    }

    private fun feedApi(read: (kotlinx.serialization.json.JsonElement?) -> dev.aethernet.linkpearl.core.data.ApiResult<kotlinx.serialization.json.JsonElement> = { ok(buildJsonObject { put("ok", true); put("unread", 1) }) }) =
        FakeApi { m, path, _, body -> if (m == "GET") ok(Contract.feed) else read(body) }

    @Test fun refreshFillsTheListAndTheBadge() = runTest {
        val (feed, badge, state) = rig(feedApi())
        feed.refresh()
        val ui = feed.state.value
        assertTrue(ui.loaded); assertEquals(2, ui.alerts.size); assertEquals(2, ui.unread)
        assertEquals(2, badge.value)
        assertEquals(mapOf(TopLevel.Alerts to 2), badge.counts.value)
        assertEquals(2, state.unreadValue)
    }

    @Test fun zeroUnreadShowsNoBadge() = runTest {
        val scope = CoroutineScope(UnconfinedTestDispatcher())
        val b = AlertsBadges(5, scope); b.set(0)
        assertEquals(emptyMap<TopLevel, Int>(), b.counts.value)
    }

    @Test fun readingClearsTheBadgeAndTakesTheServersCount() = runTest {
        val (feed, badge, _) = rig(feedApi())
        feed.refresh()
        feed.markRead(listOf(412))
        assertTrue(feed.state.value.alerts.first { it.id == 412 }.read)
        assertEquals(1, badge.value) // the server's answer
    }

    @Test fun failedReadMarkIsUndone() = runTest {
        val (feed, badge, _) = rig(feedApi { fail(ApiError.Server) })
        feed.refresh()
        feed.markRead(listOf(412))
        assertFalse(feed.state.value.alerts.first { it.id == 412 }.read)
        assertEquals(2, badge.value)
        assertEquals("Couldn't mark read", feed.state.value.error)
    }

    @Test fun markAllReadZeroesTheBadge() = runTest {
        val api = feedApi { ok(buildJsonObject { put("ok", true); put("unread", 0) }) }
        val (feed, badge, _) = rig(api)
        feed.refresh()
        feed.markAllRead()
        assertTrue(feed.state.value.alerts.all { it.read })
        assertEquals(0, badge.value)
        assertEquals(Json.parseToJsonElement("""{"all":true}"""), api.calls.last()[3])
    }

    @Test fun readNotificationsAreCancelled() = runTest {
        val cancelled = mutableListOf<Int>()
        val scope = CoroutineScope(UnconfinedTestDispatcher())
        val feed = AlertsFeed(AlertsRemote(feedApi()), scope, AlertsBadges(0, scope), MemoryCheckState(), onRead = { cancelled += it })
        feed.refresh(); feed.markRead(listOf(412))
        assertEquals(listOf(412), cancelled)
    }

    @Test fun offlineKeepsTheLastFeedInMemory() = runTest {
        val api = feedApi()
        val (feed, _, _) = rig(api)
        feed.refresh()
        api.handler = { _, _, _, _ -> fail(ApiError.Offline) }
        feed.refresh()
        val ui = feed.state.value
        assertEquals(FeedStatus.Offline, ui.status); assertEquals(2, ui.alerts.size); assertTrue(ui.loaded)
    }

    @Test fun pagingAppendsOlderEntriesWithoutDuplicates() = runTest {
        val older = """{ "v": 1, "now": "2026-10-15T20:05:00.000Z", "cursor": 412, "unread": 2, "more": false, "next": null,
            "alerts": [ { "id": 411, "store": 326, "type": "quiet", "wo": null, "at": "2026-10-15T19:41:00.000Z", "since": "2026-10-15T17:40:00.000Z", "hours": 2, "read": true, "notify": false },
                        { "id": 398, "store": 914, "type": "followup", "wo": 700000003, "at": "2026-10-14T13:00:00.000Z", "due": "2026-10-14", "kind": null, "read": true, "notify": false } ] }"""
        val api = FakeApi { _, _, q, _ -> if (q["before"] == "398") ok(Json.parseToJsonElement(older)) else ok(Contract.feed) }
        val (feed, _, _) = rig(api)
        feed.refresh(); feed.loadMore()
        assertEquals(listOf(412, 411, 398), feed.state.value.alerts.map { it.id })
        assertFalse(feed.state.value.more)
        feed.loadMore() // nothing more to load: no extra request
        assertEquals(1, api.calls.count { (it[2] as Map<*, *>)["before"] == "398" })
    }

    @Test fun storeFilterIsSentAndDoesNotTouchTheBadge() = runTest {
        val api = FakeApi { _, _, q, _ -> ok(Contract.feed) }
        val (feed, badge, _) = rig(api)
        feed.refresh(); badge.set(7)
        feed.setStore(326)
        assertEquals("326", (api.calls.last()[2] as Map<*, *>)["store"])
        assertEquals(7, badge.value)
    }

    @Test fun unreadFilterIsLocal() = runTest {
        val (feed, _, _) = rig(feedApi())
        feed.refresh(); feed.setUnreadOnly(true)
        assertEquals(listOf(412), feed.state.value.visible.map { it.id })
    }

    @Test fun seeingTheFeedMovesTheBackgroundCursorOnlyWhenNothingUnseenIsSkipped() = runTest {
        // page reaches back (not "more"): cursor moves up to the feed's cursor
        val api = FakeApi { _, _, _, _ -> ok(buildJsonObject { put("v", 1); put("cursor", 412); put("unread", 0); put("more", false); put("alerts", JsonArray(emptyList())) }) }
        val (feed, _, state) = rig(api, cursor = 398)
        feed.refresh(seen = true)
        assertEquals(412, state.cursorValue)
        // more pages and the oldest on this page is newer than the stored cursor: leave it
        val (feed2, _, state2) = rig(feedApi(), cursor = 100)
        feed2.refresh(seen = true)
        assertEquals(100, state2.cursorValue)
        // a background refresh (screen not shown) never moves it
        val (feed3, _, state3) = rig(api, cursor = 398)
        feed3.refresh(seen = false)
        assertEquals(398, state3.cursorValue)
    }

    @Test fun firstRunCursorIsNeverInventedByTheFeed() = runTest {
        val (feed, _, state) = rig(feedApi(), cursor = null)
        feed.refresh(seen = true)
        assertEquals(null, state.cursorValue)
    }
}
