package dev.aethernet.linkpearl.feature.push

import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.data.Credentials
import dev.aethernet.linkpearl.core.nav.Routes
import dev.aethernet.linkpearl.feature.linkshell.StoredLink
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PushCenterTest {
    private val linkId = "a".repeat(32)
    private val link = StoredLink(linkId, 900, "Chrome · Mac", "AAAA")
    private fun ping(id: String = "msg-00000001", kind: String = "pullbacks.run", l: String = linkId) = mapOf("t" to "linkshell", "link" to l, "kind" to kind, "id" to id)

    private class FakeApi(var ok: Boolean = true) : ApiClient {
        val posts = mutableListOf<Pair<String, JsonElement?>>()
        override suspend fun get(path: String, query: Map<String, String>) = ApiResult.Failure(ApiError.NotFound, 404)
        override suspend fun post(path: String, body: JsonElement?): ApiResult<JsonElement> {
            posts += path to body
            return if (ok) ApiResult.Success(buildJsonObject { }) else ApiResult.Failure(ApiError.Offline)
        }
        override suspend fun put(path: String, body: JsonElement?) = ApiResult.Failure(ApiError.NotFound, 404)
        override suspend fun delete(path: String) = ApiResult.Failure(ApiError.NotFound, 404)
    }
    private class Memo : PushCenter.TokenMemo { var v: String? = null; override fun get() = v; override fun set(v: String) { this.v = v } }

    @Test fun parse() {
        assertEquals(PushPing(linkId, "pullbacks.run", "msg-00000001"), PushPing.parse(ping()))
        assertNull(PushPing.parse(ping() + ("t" to "other")))
        assertNull(PushPing.parse(ping(l = "nope")))
        assertNull(PushPing.parse(ping(kind = "Bad Kind")))
        assertNull(PushPing.parse(ping(id = "x")))
        assertEquals(PushNote("m", "Pullbacks ready to scan", "PC", Routes.LINKSHELL), noteFor(PushPing(linkId, "pullbacks.run", "m"), "PC"))
        assertEquals("Linkshell request", noteFor(PushPing(linkId, "buybacks.start", "m"), "PC").title)
    }

    @Test fun orderingPaused() = runTest {
        val data = mapOf("t" to "retrace", "kind" to "source.paused", "id" to "rs914-mgx1a2b3", "store" to "914", "n" to "12")
        assertEquals(OrderingPing("rs914-mgx1a2b3", 914, 12), OrderingPing.parse(data))
        assertNull(OrderingPing.parse(data + ("kind" to "other")))
        assertNull(OrderingPing.parse(data + ("store" to "nine")))
        assertNull(OrderingPing.parse(data + ("id" to "x")))
        assertEquals(PushNote("m", "Ordering paused", "914 · 1 item not marked", Routes.RETRACE, PushModule.ORDERING), noteFor(OrderingPing("m", 914, 1)))
        val shown = mutableListOf<PushNote>()
        val c = PushCenter(FakeApi(), { null }, { null }, { }, { shown += it }, Memo(), this)
        val n = c.onPing(data)!!
        assertEquals("914 · 12 items not marked", n.text)
        assertEquals(listOf(n), shown)
        assertNull("once per pause", c.onPing(data))
    }

    @Test fun backgroundNotifiesForegroundBanners() = runTest {
        val shown = mutableListOf<PushNote>()
        var wakes = 0
        var current: StoredLink? = link
        val c = PushCenter(FakeApi(), { null }, { current }, { wakes++ }, { shown += it }, Memo(), this)
        val n = c.onPing(ping())!!
        assertEquals(listOf(n), shown)
        assertEquals("Chrome · Mac", n.text)
        assertNull("a repeat of the same id", c.onPing(ping()))
        assertNull("another link's ping", c.onPing(ping(id = "msg-00000002", l = "b".repeat(32))))
        current = null
        assertNull("not linked", c.onPing(ping(id = "msg-00000003")))
        current = link
        c.started = 1
        val banner = launch { assertEquals("msg-00000004", c.banners.first().id) }
        testScheduler.runCurrent()
        c.onPing(ping(id = "msg-00000004"))
        banner.join()
        assertEquals("foreground: no system notification", 1, shown.size)
        assertEquals(1, wakes)
    }

    @Test fun tokenSentOncePerDeviceAndToken() = runTest {
        val api = FakeApi(ok = false)
        val memo = Memo()
        var creds: Credentials? = null
        val c = PushCenter(api, { creds }, { link }, {}, {}, memo, this)
        assertFalse("not registered yet", c.register("tok-1"))
        assertTrue(api.posts.isEmpty())
        creds = Credentials("d".repeat(32), "t".repeat(64))
        assertFalse(c.register("tok-1"))
        assertNull("failed: tried again next time", memo.v)
        api.ok = true
        assertTrue(c.register("tok-1"))
        assertTrue(c.register("tok-1"))
        assertEquals(2, api.posts.size)
        val body = api.posts.last().second as JsonObject
        assertEquals(PushCenter.PATH, api.posts.last().first)
        assertEquals(JsonPrimitive("tok-1"), body["token"]); assertEquals(JsonPrimitive("android"), body["platform"])
        c.register("tok-2")
        assertEquals(3, api.posts.size)
    }
}
