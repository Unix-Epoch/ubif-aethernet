package dev.aethernet.linkpearl.core.data

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The registration state machine against real server answers (src/test/resources/fixtures, captured from the Worker's own code). */
class RealAuthTest {
    private val ME = "GET /v1/agents/me"
    private val REGISTER = "POST /v1/agents/register"
    private lateinit var server: MockWebServer
    private lateinit var script: Script
    private lateinit var dir: File
    private lateinit var store: SessionStore
    private lateinit var identity: SoftwareIdentity
    private var wiped = 0
    private val servers = mutableListOf<MockWebServer>()

    private fun begin(vararg routes: Pair<String, List<MockResponse>>, scope: kotlinx.coroutines.CoroutineScope? = null): RealAuth {
        script = Script(*routes); server = mockServer(script).also(servers::add)
        dir = tempDir(); store = newSessionStore(dir); identity = SoftwareIdentity(store)
        return auth(scope)
    }

    private lateinit var client: OkHttpApiClient
    private fun auth(scope: kotlinx.coroutines.CoroutineScope? = null, st: SessionStore = store): RealAuth {
        lateinit var a: RealAuth
        client = server.client(credentials = { st.current.credentials }, hooks = { a })
        a = RealAuth(st, client, identity, resetKey = { identity.reset() }, wipeData = { wiped++ }, scope = scope)
        return a
    }

    @After fun stop() = servers.forEach { runCatching { it.shutdown() } }
    private fun r(name: String) = MockResponse().answer(name)
    private fun body(req: RecordedRequest) = req.body.peek().readUtf8().let { LinkpearlJson.parseToJsonElement(it).jsonObject }

    @Test fun startsUnregistered() {
        val a = begin()
        assertEquals(AuthState.Unregistered, a.state.value); assertNull(a.issue.value)
    }

    @Test fun registerSendsWhatTheContractAsksForAndMovesToPending() = runBlocking {
        val a = begin(REGISTER to listOf(r("register")))
        assertTrue(a.register("  Pixel Fold  "))
        val sent = script.seen.single()
        assertEquals("test-key", sent.getHeader("x-aethernet-key")); assertNull(sent.getHeader("authorization"))
        val b = body(sent)
        assertEquals(setOf("id", "name", "kind", "publicJwk", "token"), b.keys)
        assertTrue(Regex("^[0-9a-f]{32}$").matches(b["id"]!!.jsonPrimitive.content))
        assertTrue(Regex("^[0-9a-f]{64}$").matches(b["token"]!!.jsonPrimitive.content))
        assertEquals("Pixel Fold", b["name"]!!.jsonPrimitive.content); assertEquals("phone", b["kind"]!!.jsonPrimitive.content)
        val jwk = b["publicJwk"]!!.jsonObject
        assertEquals(setOf("kty", "crv", "x", "y"), jwk.keys) // never a private "d"
        assertEquals(43, jwk["x"]!!.jsonPrimitive.content.length); assertEquals(43, jwk["y"]!!.jsonPrimitive.content.length)
        // state, and what was saved
        val fp = fixture("register").json.jsonObject["fingerprint"]!!.jsonPrimitive.content
        assertEquals(AuthState.Pending(fp, "Pixel Fold"), a.state.value)
        assertEquals(b["id"]!!.jsonPrimitive.content, identity.deviceId); assertEquals(b["token"]!!.jsonPrimitive.content, store.current.token)
        assertEquals("pending", store.current.status)
    }

    @Test fun pendingBecomesRegisteredWithStoresAndWrappedKeysOnceApproved() = runBlocking {
        val a = begin(REGISTER to listOf(r("register")), ME to listOf(r("me-pending"), r("me-active")))
        a.register("Pixel Fold")
        a.refresh()
        assertTrue(a.state.value is AuthState.Pending)
        a.refresh()
        val s = a.state.value as AuthState.Registered
        assertEquals(listOf(914, 326), s.stores.map { it.id }); assertEquals("Pixel Fold", s.name)
        // the refresh used the Bearer from registration
        val me = script.seen.last()
        assertEquals("Bearer ${store.current.deviceId}.${store.current.token}", me.getHeader("authorization"))
        // wrapped store keys, straight from /me
        val keys = RealStoreKeys(store, a).wrapped()
        assertEquals(setOf(326, 914), keys.keys); assertTrue(keys.values.all { it.startsWith("v1.") })
        val expected = fixture("me-active").json.jsonObject["keys"]!!.let { (it as kotlinx.serialization.json.JsonArray).associate { k -> k.jsonObject["store"]!!.jsonPrimitive.content.toInt() to k.jsonObject["wrapped"]!!.jsonPrimitive.content } }
        assertEquals(expected, keys)
        assertEquals(2, RealStoreKeys(store, a).wrapped(refresh = true).size)
    }

    @Test fun approvedWithNoStoresIsRegisteredWithAnEmptyList() = runBlocking {
        val a = begin(REGISTER to listOf(r("register")), ME to listOf(r("me-active-no-stores")))
        a.register("Pixel Fold"); a.refresh()
        assertEquals(emptyList<StoreRef>(), (a.state.value as AuthState.Registered).stores)
        assertEquals(emptyMap<Int, String>(), RealStoreKeys(store, a).wrapped())
    }

    @Test fun revokedGoesBackToFirstRunWithOneNoticeAndForgetsEverything() = runBlocking {
        val a = begin(REGISTER to listOf(r("register")), ME to listOf(r("me-active"), r("me-revoked")))
        a.register("Pixel Fold"); a.refresh()
        val oldId = store.current.deviceId
        a.refresh()
        assertEquals(AuthState.Unregistered, a.state.value); assertEquals(AuthIssue.Revoked, a.issue.value)
        assertNull(store.current.token); assertNull(store.current.deviceId); assertTrue(store.current.keys.isEmpty())
        assertEquals(1 + 1, identity.resets) // once when registering fresh, once on the revocation
        assertEquals(1, wiped)
        // the notice survives a restart, and goes away when dismissed
        assertEquals(AuthIssue.Revoked, auth(st = SessionStore(EncryptedFile(File(dir, "session.bin"), testBox))).issue.value)
        a.dismissIssue(); assertNull(a.issue.value)
        // registering again: a NEW id and token, and a new key pair
        script.set(REGISTER, r("register"))
        assertTrue(a.register("Pixel Fold"))
        assertNotEquals(oldId, store.current.deviceId); assertEquals(3, identity.resets)
        assertNull(a.issue.value)
        val ids = script.seen.filter { it.method == "POST" }.map { body(it)["id"]!!.jsonPrimitive.content }
        assertEquals(2, ids.distinct().size)
    }

    @Test fun offlineErrorsAndTheCapMapToIssuesAndNeverChangeState() = runBlocking {
        val a = begin(REGISTER to listOf(r("register-too-many-waiting")))
        assertFalse(a.register("Pixel")); assertEquals(AuthIssue.Limit, a.issue.value); assertEquals(AuthState.Unregistered, a.state.value)
        script.set(REGISTER, MockResponse().setResponseCode(500).setBody("""{"error":"server error (id 1a2b3c4d)"}"""))
        assertFalse(a.register("Pixel")); assertEquals(AuthIssue.Server, a.issue.value)
        script.set(REGISTER, r("wrong-app-key"))
        assertFalse(a.register("Pixel")); assertEquals(AuthIssue.Refused, a.issue.value)
        script.set(REGISTER, r("register-bad-kind"))
        assertFalse(a.register("Pixel")); assertEquals(AuthIssue.Refused, a.issue.value)
        server.shutdown()
        assertFalse(a.register("Pixel")); assertEquals(AuthIssue.Offline, a.issue.value); assertEquals(AuthState.Unregistered, a.state.value)
    }

    @Test fun aFailedRegistrationIsRetriedWithTheSameIdTokenAndKey() = runBlocking {
        val a = begin(REGISTER to listOf(MockResponse().setResponseCode(500).setBody("""{"error":"server error (id 1)"}"""), r("register")))
        assertFalse(a.register("Pixel"))
        val first = body(script.seen[0])
        assertTrue(a.register("Pixel"))
        val second = body(script.seen[1])
        assertEquals(first["id"], second["id"]); assertEquals(first["token"], second["token"]); assertEquals(first["publicJwk"], second["publicJwk"])
        assertEquals(1, identity.resets) // the key pair was created once
    }

    @Test fun ifTheAnswerWasLostTheDuplicateIsAdoptedThroughMe() = runBlocking {
        // The server registered us but the answer never arrived; the retry hits 409 and reads the registration back with the same token.
        val a = begin(REGISTER to listOf(MockResponse().setResponseCode(500).setBody("""{"error":"server error (id 2)"}"""), r("register-duplicate")), ME to listOf(r("me-pending")))
        assertFalse(a.register("Pixel Fold"))
        assertTrue(a.register("Pixel Fold"))
        assertTrue(a.state.value is AuthState.Pending)
        assertEquals("pending", store.current.status)
    }

    @Test fun aDuplicateThatIsNotOursIsDroppedSoTheNextAttemptUsesANewId() = runBlocking {
        val a = begin(REGISTER to listOf(r("register-duplicate")), ME to listOf(r("wrong-token")))
        assertFalse(a.register("Pixel Fold")); assertNull(store.current.deviceId)
    }

    @Test fun signOutDeletesTokenStateAndKey() = runBlocking {
        val a = begin(REGISTER to listOf(r("register")))
        a.register("Pixel Fold")
        a.signOut()
        assertEquals(AuthState.Unregistered, a.state.value)
        assertEquals(StoredSession(), store.current); assertFalse(File(dir, "session.bin").exists())
        assertEquals(1, wiped); assertNull(a.issue.value)
        assertEquals("only the registration itself went to the server (the contract has no self-removal)", 1, script.seen.size)
    }

    @Test fun pendingAndRegisteredSurviveARestart() = runBlocking {
        val a = begin(REGISTER to listOf(r("register")), ME to listOf(r("me-active")))
        a.register("Pixel Fold")
        val again = auth(st = SessionStore(EncryptedFile(File(dir, "session.bin"), testBox)))
        assertTrue(again.state.value is AuthState.Pending)
        again.refresh()
        assertTrue(auth(st = SessionStore(EncryptedFile(File(dir, "session.bin"), testBox))).state.value is AuthState.Registered)
    }

    @Test fun serverTroubleWhileWaitingKeepsTheStateAndShowsAnIssue() = runBlocking {
        val a = begin(REGISTER to listOf(r("register")), ME to listOf(MockResponse().setResponseCode(503).setBody("{}"), r("me-pending")))
        a.register("Pixel Fold"); a.refresh()
        assertTrue(a.state.value is AuthState.Pending); assertEquals(AuthIssue.Server, a.issue.value)
        a.refresh(); assertNull(a.issue.value)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test fun aRejectedTokenOnAnyCallRechecksTheRegistration() = runTest(UnconfinedTestDispatcher()) {
        val a = begin(REGISTER to listOf(r("register")), ME to listOf(r("me-revoked")), "GET /v1/agents/m/home" to listOf(r("wrong-token")), scope = backgroundScope)
        a.register("Pixel Fold")
        client.get("/v1/agents/m/home") // 401 -> hook -> /me -> 401 -> forgotten
        advanceUntilIdle()
        runBlocking { for (i in 1..50) { if (a.state.value is AuthState.Unregistered) break; Thread.sleep(20) } }
        assertEquals(AuthState.Unregistered, a.state.value); assertEquals(AuthIssue.Revoked, a.issue.value)
    }

    @Test fun deviceNamesAreCleaned() {
        assertEquals("Pixel Fold", RealAuth.cleanName("\u0000Pixel\u0007 Fold \n"))
        assertEquals(60, RealAuth.cleanName("x".repeat(100)).length)
        assertEquals("", RealAuth.cleanName(" \t "))
    }

    @Test fun aBlankNameDoesNotRegister() = runBlocking {
        val a = begin(REGISTER to listOf(r("register")))
        assertFalse(a.register("   ")); assertEquals(0, script.seen.size)
    }

    @Test fun storeNamesFromHomeAreRemembered() = runBlocking {
        val a = begin(REGISTER to listOf(r("register")), ME to listOf(r("me-active")))
        a.register("Pixel Fold"); a.refresh()
        a.rememberStoreNames(listOf(StoreRef(914, "Newport News"), StoreRef(326, "Lynnhaven"), StoreRef(5, "Other")))
        assertEquals(listOf("Newport News", "Lynnhaven"), (a.state.value as AuthState.Registered).stores.map { it.name })
        a.refresh() // names survive the next /me
        assertEquals(listOf("Newport News", "Lynnhaven"), (a.state.value as AuthState.Registered).stores.map { it.name })
    }
}
