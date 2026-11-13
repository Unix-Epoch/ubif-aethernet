package dev.aethernet.linkpearl.core.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.spec.PKCS8EncodedKeySpec

/**
 * The client against the REAL tracker Worker code, served locally over HTTP by android/tools/local-server.mjs (local D1, nothing remote).
 * Skipped unless LINKPEARL_LOCAL_SERVER is set, e.g.:
 *   (cd tracker-worker && node ../android/tools/local-server.mjs serve 8799) &
 *   LINKPEARL_LOCAL_SERVER=http://127.0.0.1:8799 ./gradlew :app:testDebugUnitTest --tests '*LocalServerIntegrationTest'
 */
class LocalServerIntegrationTest {
    private val base = System.getenv("LINKPEARL_LOCAL_SERVER")

    private fun control(path: String, json: String) {
        val r = OkHttpClient().newCall(Request.Builder().url(base + path).post(json.toRequestBody("application/json".toMediaType())).build()).execute()
        r.use { assertEquals(path + " " + it.body.string(), 200, it.code) }
    }

    @Test fun registerApproveUnwrapHomeRevoke() = runBlocking {
        assumeTrue("LINKPEARL_LOCAL_SERVER not set", base != null)
        val store = newSessionStore()
        val identity = SoftwareIdentity(store)
        lateinit var auth: RealAuth
        val client = OkHttpApiClient(base!!, "k", { store.current.credentials }, { auth }, allowLoopbackHttp = true)
        auth = RealAuth(store, client, identity, { identity.reset() })

        // register: the server accepts our id, token and JWK, and its fingerprint equals the one computed from our JWK the way the server does
        assertTrue(auth.register("Integration phone"))
        val pending = auth.state.value as AuthState.Pending
        val jwk = identity.publicJwk()
        val canonical = """{"crv":"P-256","kty":"EC","x":"${jwk["x"]!!.jsonPrimitive.content}","y":"${jwk["y"]!!.jsonPrimitive.content}"}"""
        val expected = MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray()).joinToString("") { "%02X".format(it) }.take(16).chunked(4).joinToString("-")
        assertEquals(expected, pending.fingerprint)

        auth.refresh(); assertTrue("not approved yet", auth.state.value is AuthState.Pending)
        // Home is refused until approval, and the refusal is the contract's "not approved yet"
        val early = client.get("/v1/agents/m/home", mapOf("store" to "all")) as ApiResult.Failure
        assertEquals(403, early.status); assertEquals("not approved yet", early.message)

        // the owner approves on the admin site (the local control route does what the admin page's Approve does)
        control("/__ctl/approve", """{"id":"${store.current.deviceId}","stores":[914,326]}""")
        auth.refresh()
        val registered = auth.state.value as AuthState.Registered
        assertEquals(listOf(914, 326), registered.stores.map { it.id })

        // hop 1: our device key opens the wrapped store keys (ECDH via DeviceIdentity.agree, HKDF, AES-GCM, aad agentkey|<id>|<store>)
        val wrapped = RealStoreKeys(store, auth).wrapped(refresh = true)
        assertEquals(setOf(914, 326), wrapped.keys)
        for ((st, w) in wrapped) {
            val pkcs8 = openSealed(w, "agentkey|${identity.deviceId}|$st") { identity.agree(it) }
            KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(pkcs8)) // a real P-256 PKCS#8 store key
        }

        // Home on live numbers
        val repo = RealHomeRepository(client, onStores = { auth.rememberStoreNames(it) })
        val all = (repo.load(StoreScope.All, fresh = true) as HomeResult.Ok).data
        assertEquals(setOf(914, 326), all.stores.map { it.id }.toSet()); assertTrue(all.sales.today != null && all.sales.today!! > 0)
        val one = (repo.load(StoreScope.One(914)) as HomeResult.Ok).data
        assertEquals(1800.0, one.sales.today!!, 0.0)
        assertEquals(HomeResult.Failed(FailureReason.NotYourStore), repo.load(StoreScope.One(536)))
        assertEquals(listOf("Lynnhaven", "Newport News"), (auth.state.value as AuthState.Registered).stores.mapNotNull { it.name }.sorted())

        // revoked on the admin page: the next call is a 401 and the phone forgets itself
        control("/__ctl/remove", """{"id":"${store.current.deviceId}"}""")
        assertEquals(HomeResult.Failed(FailureReason.Unauthorized), repo.load(StoreScope.All))
        auth.refresh()
        assertEquals(AuthState.Unregistered, auth.state.value); assertEquals(AuthIssue.Revoked, auth.issue.value)
    }
}
