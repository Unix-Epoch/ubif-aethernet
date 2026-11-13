package dev.aethernet.linkpearl.core.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OkHttpApiClientTest {
    private val creds = Credentials("a".repeat(32), "b".repeat(64))
    private val servers = mutableListOf<okhttp3.mockwebserver.MockWebServer>()
    private fun serve(vararg routes: Pair<String, List<MockResponse>>) = Script(*routes).let { s -> mockServer(s).also(servers::add) to s }
    @After fun stop() = servers.forEach { runCatching { it.shutdown() } }

    private fun failure(r: ApiResult<*>) = r as ApiResult.Failure

    @Test fun everyRequestCarriesTheAppKeyAndTheBearerOnceRegistered() = runBlocking {
        val (srv, script) = serve("GET /v1/agents/me" to listOf(MockResponse().answer("me-active")), "POST /v1/agents/register" to listOf(MockResponse().answer("register")))
        val withCreds = srv.client(credentials = { creds })
        assertTrue(withCreds.get("/v1/agents/me") is ApiResult.Success)
        val r = script.seen.single()
        assertEquals("test-key", r.getHeader("x-aethernet-key"))
        assertEquals("Bearer ${creds.id}.${"b".repeat(64)}", r.getHeader("authorization"))
        assertTrue(Regex("^Bearer [0-9a-f]{32}\\.[0-9a-f]{64}$").matches(r.getHeader("authorization")!!))

        val anonymous = srv.client()
        anonymous.post("/v1/agents/register", JsonObject(mapOf("id" to JsonPrimitive("x"))))
        val reg = script.seen.last()
        assertEquals("test-key", reg.getHeader("x-aethernet-key")); assertNull(reg.getHeader("authorization"))
        assertTrue(reg.getHeader("content-type")!!.startsWith("application/json"))
        assertEquals("""{"id":"x"}""", reg.body.readUtf8())
    }

    @Test fun queryAndPathAreEncodedByTheClient() = runBlocking {
        val (srv, script) = serve("GET /v1/agents/m/home" to listOf(MockResponse().answer("home-one")))
        srv.client(credentials = { creds }).get("/v1/agents/m/home", mapOf("store" to "914", "fresh" to "1"))
        assertEquals("/v1/agents/m/home?store=914&fresh=1", script.seen.single().path)
    }

    @Test fun realErrorBodiesMapToApiErrors() = runBlocking {
        val cases = listOf(
            "wrong-token" to (ApiError.Unauthorized to "unknown program or wrong token"),
            "wrong-app-key" to (ApiError.Forbidden to "app key required"),
            "home-not-approved" to (ApiError.Forbidden to "not approved yet"),
            "home-not-your-store" to (ApiError.Forbidden to "not your store"),
            "home-bad-store" to (ApiError.Server to null), // 400: callers read .status
            "register-too-many-waiting" to (ApiError.RateLimited to "too many phones waiting for approval"),
            "register-duplicate" to (ApiError.Server to "already registered"),
            "not-built" to (ApiError.Server to "not built"),
        )
        for ((name, expect) in cases) {
            val f = fixture(name)
            val (srv, _) = serve("GET /x" to listOf(MockResponse().answer(name)))
            val r = failure(srv.client().get("/x"))
            assertEquals(name, expect.first, r.error)
            assertEquals(name, f.status, r.status)
            if (expect.second != null) assertEquals(name, expect.second, r.message)
        }
    }

    @Test fun plainStatusMapping() = runBlocking {
        for ((code, error) in listOf(404 to ApiError.NotFound, 429 to ApiError.RateLimited, 500 to ApiError.Server, 502 to ApiError.Server, 503 to ApiError.Server, 302 to ApiError.Server)) {
            val (srv, _) = serve("GET /x" to listOf(MockResponse().setResponseCode(code).setBody("not json")))
            assertEquals("$code", error, failure(srv.client().get("/x")).error)
        }
    }

    @Test fun aRejectedTokenOrAnUnapprovedPhoneTellsTheSessionOnlyForNormalCalls() = runBlocking {
        var calls = 0
        val hooks = SessionHooks { calls++ }
        for ((name, expected) in listOf("wrong-token" to 1, "home-not-approved" to 1, "home-not-your-store" to 0, "wrong-app-key" to 0, "home-one" to 0)) {
            calls = 0
            val (srv, _) = serve("GET /x" to listOf(MockResponse().answer(name)))
            srv.client(hooks = { hooks }).get("/x")
            assertEquals(name, expected, calls)
        }
        calls = 0
        val (srv, _) = serve("GET /x" to listOf(MockResponse().answer("wrong-token")))
        srv.client(hooks = { hooks }).call("GET", "/x", credentials = null, notify = false) // registration and /me checks must not loop back
        assertEquals(0, calls)
    }

    @Test fun getsRetryOnceOnATransientNetworkErrorButPostsDoNot() = runBlocking {
        // (MockWebServer only honours SocketPolicy through its own queue, hence enqueue instead of a Script.)
        fun queued(vararg r: MockResponse) = okhttp3.mockwebserver.MockWebServer().also { s -> r.forEach(s::enqueue); s.start(); servers += s }
        val disconnect = { MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START) }

        val get = queued(disconnect(), MockResponse().answer("home-one"))
        assertTrue(get.client().get("/x") is ApiResult.Success)
        assertEquals(2, get.requestCount)

        val post = queued(disconnect(), MockResponse().answer("register"))
        assertEquals(ApiError.Offline, failure(post.client().post("/y")).error)
        assertEquals(1, post.requestCount)

        val twice = queued(disconnect(), disconnect(), MockResponse().answer("home-one"))
        assertEquals(ApiError.Offline, failure(twice.client().get("/z")).error)
        assertEquals("one retry, no more", 2, twice.requestCount)
    }

    @Test fun noServerAtAllIsOffline() = runBlocking {
        val (srv, _) = serve("GET /x" to listOf(MockResponse().answer("home-one")))
        val client = srv.client(); srv.shutdown()
        assertEquals(ApiError.Offline, failure(client.get("/x")).error)
    }

    @Test fun anAnswerOverTheCapIsRefused() = runBlocking {
        val (srv, _) = serve("GET /x" to listOf(MockResponse().setBody("""{"a":"${"z".repeat(5000)}"}""")))
        val r = failure(srv.client(maxBytes = 1000).get("/x"))
        assertEquals(ApiError.Server, r.error)
        assertTrue(srv.client(maxBytes = 10_000).get("/x") is ApiResult.Success)
    }

    @Test fun badJsonOnA200IsAServerError() = runBlocking {
        val (srv, _) = serve("GET /x" to listOf(MockResponse().setBody("<html>")))
        assertEquals(ApiError.Server, failure(srv.client().get("/x")).error)
    }

    @Test fun redirectsAreNotFollowed() = runBlocking {
        val (srv, script) = serve("GET /x" to listOf(MockResponse().setResponseCode(302).setHeader("location", "http://evil.example/")))
        assertEquals(ApiError.Server, failure(srv.client(credentials = { creds }).get("/x")).error)
        assertEquals(1, script.seen.size)
    }

    @Test fun onlyHttpsIsAcceptedExceptLoopbackWhenAllowed() {
        for (bad in listOf("http://aethernet-tracker.example.workers.dev", "http://192.168.1.5:8787")) {
            try { OkHttpApiClient(bad, "k", { null }, allowLoopbackHttp = true); throw AssertionError("accepted $bad") } catch (_: IllegalArgumentException) {}
        }
        try { OkHttpApiClient("http://localhost:8787", "k", { null }); throw AssertionError("accepted loopback without the allowance") } catch (_: IllegalArgumentException) {}
        OkHttpApiClient("https://aethernet-tracker.ubifaethernet.workers.dev", "k", { null })
        OkHttpApiClient("http://localhost:8787", "k", { null }, allowLoopbackHttp = true)
    }

    @Test fun theTokenIsNeverInAResultOrItsStringForm() = runBlocking {
        val token = "c".repeat(64)
        val c = Credentials("d".repeat(32), token)
        assertFalse(c.toString().contains(token))
        val (srv, _) = serve("GET /x" to listOf(MockResponse().answer("wrong-token")))
        val r = srv.client(credentials = { c }).get("/x")
        assertFalse(r.toString().contains(token))
        assertFalse(StoredSession(deviceId = "d".repeat(32), token = token).toString().contains(token))
    }

    @Test fun anEmptyBodyOn200IsAnEmptyObject() = runBlocking {
        val (srv, _) = serve("DELETE /x" to listOf(MockResponse().setResponseCode(200)))
        val r = srv.client().delete("/x") as ApiResult.Success
        assertEquals(0, r.value.jsonObject.size)
        assertEquals("1", ((srv.client().let { runBlocking { it.get("/missing") } }) as ApiResult.Failure).status?.let { "1" })
        assertEquals("ok", JsonPrimitive("ok").jsonPrimitive.content)
    }
}
