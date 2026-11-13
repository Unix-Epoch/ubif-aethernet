package dev.aethernet.linkpearl.core.data

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.Files
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import java.util.zip.GZIPInputStream
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** A real server answer captured by android/tools/local-server.mjs from the tracker Worker's own code (src/test/resources/fixtures). */
class Fixture(val status: Int, val body: String) {
    val json: JsonElement get() = LinkpearlJson.parseToJsonElement(body)
}

fun fixture(name: String): Fixture {
    val text = Fixture::class.java.getResource("/fixtures/$name.json")!!.readText()
    val o = LinkpearlJson.parseToJsonElement(text) as JsonObject
    return Fixture(o["status"].toString().toInt(), o["body"].toString())
}

fun MockResponse.answer(name: String): MockResponse = fixture(name).let { setResponseCode(it.status).setHeader("content-type", "application/json").setBody(it.body) }

/** Routes by "METHOD /path" (query ignored). Each route is a queue; the last answer repeats. Records every request. */
class Script(vararg routes: Pair<String, List<MockResponse>>) : Dispatcher() {
    private val queues = routes.associate { it.first to ArrayDeque(it.second) }.toMutableMap()
    val seen = mutableListOf<RecordedRequest>()
    private var last = mutableMapOf<String, MockResponse>()

    fun set(route: String, vararg answers: MockResponse) { queues[route] = ArrayDeque(answers.toList()); last.remove(route) }

    @Synchronized
    override fun dispatch(request: RecordedRequest): MockResponse {
        seen += request
        val key = request.method + " " + request.requestUrl!!.encodedPath
        val q = queues[key] ?: return MockResponse().setResponseCode(404).setBody("""{"error":"not found"}""")
        val next = q.removeFirstOrNull()?.also { last[key] = it } ?: last[key] ?: MockResponse().setResponseCode(404)
        return next
    }
}

fun mockServer(script: Dispatcher): MockWebServer = MockWebServer().apply { dispatcher = script; start() }

fun MockWebServer.client(
    credentials: () -> Credentials? = { null },
    hooks: () -> SessionHooks? = { null },
    maxBytes: Long = 4L * 1024 * 1024,
) = OkHttpApiClient(url("/").toString(), "test-key", credentials, hooks, maxBytes = maxBytes, allowLoopbackHttp = true)

val testBox = AesGcmBox { SecretKeySpec(ByteArray(32) { it.toByte() }, "AES") }

fun tempDir(): File = Files.createTempDirectory("lp-test").toFile().also { it.deleteOnExit() }

fun newSessionStore(dir: File = tempDir(), name: String = "session.bin") = SessionStore(EncryptedFile(File(dir, name), testBox))

/** A software P-256 key pair standing in for the Keystore key (same P256 helpers, same ECDH). */
class SoftwareIdentity(private val store: SessionStore) : ManagedIdentity {
    private var pair: KeyPair? = null
    var resets = 0
    override val deviceId: String? get() = store.current.deviceId
    override val requiresUserAuth = true
    private fun key() = pair ?: KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair().also { pair = it }
    override fun publicJwk() = P256.jwk(key().public as ECPublicKey)
    override fun agree(peerPublic: ByteArray) = P256.agree(key().private, peerPublic)
    override fun reset() { pair = null; resets++ }
}

// ---- the server's sealed format (MOBILE-API.md "Sealed data"), enough to prove the key and the ECDH output agree with src/crypto.js
fun unb64u(s: String): ByteArray = Base64.getUrlDecoder().decode(s)

fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int = 32): ByteArray {
    fun hmac(key: ByteArray, data: ByteArray) = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }.doFinal(data)
    val prk = hmac(salt, ikm)
    return hmac(prk, info + byteArrayOf(1)).copyOf(length)
}

/** Opens a "v1." sealed value with [agree] (a function from the sender's ephemeral public key to the ECDH secret). */
fun openSealed(sealed: String, aad: String, agree: (ByteArray) -> ByteArray): ByteArray {
    require(sealed.startsWith("v1."))
    val raw = unb64u(sealed.removePrefix("v1."))
    val epk = raw.copyOfRange(0, 65); val iv = raw.copyOfRange(65, 77); val ct = raw.copyOfRange(77, raw.size)
    val key = hkdf(agree(epk), epk, "aethernet-tracker v1".toByteArray())
    val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv)); updateAAD(aad.toByteArray()) }
    return c.doFinal(ct)
}

fun gunzip(bytes: ByteArray): ByteArray = GZIPInputStream(ByteArrayInputStream(bytes)).readBytes()
