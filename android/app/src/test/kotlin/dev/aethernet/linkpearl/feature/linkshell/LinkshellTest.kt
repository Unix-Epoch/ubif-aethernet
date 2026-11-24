package dev.aethernet.linkpearl.feature.linkshell

import dev.aethernet.linkpearl.feature.buybacks.BbScanState
import dev.aethernet.linkpearl.feature.buybacks.BbUi
import dev.aethernet.linkpearl.feature.buybacks.BuybackLink
import dev.aethernet.linkpearl.feature.buybacks.BuybackViewModel
import dev.aethernet.linkpearl.feature.buybacks.Buybacks

import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.data.Credentials
import dev.aethernet.linkpearl.core.data.LinkpearlJson
import dev.aethernet.linkpearl.core.data.P256
import dev.aethernet.linkpearl.feature.morningcheck.MorningCheckLink
import dev.aethernet.linkpearl.feature.pullbacks.PbSession
import dev.aethernet.linkpearl.feature.pullbacks.PbStatus
import dev.aethernet.linkpearl.feature.pullbacks.PcItem
import dev.aethernet.linkpearl.feature.pullbacks.PcRun
import dev.aethernet.linkpearl.feature.pullbacks.PcState
import dev.aethernet.linkpearl.feature.pullbacks.PullbackLink
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPair
import java.security.interfaces.ECPublicKey
import java.security.spec.ECPrivateKeySpec
import java.util.Base64

/**
 * Linkshell on the phone: sealing against the browser's own output (resources linkshell/interop.json, made by src/67-linkshell.js with
 * throwaway keys), the pairing code, the connection's delivery rules over a fake socket, pairing in the view model, and a Pullbacks run
 * joined from the browser. Fake data only.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class LinkshellTest {
    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    private val fx: JsonObject = LinkpearlJson.parseToJsonElement(javaClass.getResource("/linkshell/interop.json")!!.readText()).jsonObject
    private fun JsonObject.s(k: String) = (this[k] as JsonPrimitive).contentOrNull!!
    private val linkId = fx.s("linkId")
    private val pcPub = fx["pcPub"]!!.jsonObject
    private val phonePriv = fx["phonePriv"]!!.jsonObject
    private val phonePub = JsonObject(phonePriv.filterKeys { it != "d" })
    private fun phoneKey(): ByteArray {
        val d = BigInteger(1, Base64.getUrlDecoder().decode(phonePriv.s("d")))
        val priv = KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(d, P256.params))
        return LinkshellCrypto.linkKey(P256.agree(priv, LinkshellCrypto.uncompressed(pcPub)), linkId)
    }

    @Test fun opensWhatTheBrowserSealed() {
        val m = fx["msg"]!!.jsonObject
        val body = LinkshellCrypto.open(phoneKey(), linkId, "pc", m.s("id"), m.s("kind"), m.s("iv"), m.s("ct"))
        assertEquals(m["body"], LinkpearlJson.parseToJsonElement(body))
        // bound to its envelope
        assertTrue(runCatching { LinkshellCrypto.open(phoneKey(), linkId, "phone", m.s("id"), m.s("kind"), m.s("iv"), m.s("ct")) }.isFailure)
        assertTrue(runCatching { LinkshellCrypto.open(phoneKey(), linkId, "pc", m.s("id"), "pullbacks.scan", m.s("iv"), m.s("ct")) }.isFailure)
    }

    @Test fun checkCodeMatchesTheBrowser() = assertEquals(fx.s("check"), LinkshellCrypto.checkCode(pcPub, phonePub))

    @Test fun hkdfMatchesRfc5869() {
        // RFC 5869 test case 1
        val hex = { s: String -> s.chunked(2).map { it.toInt(16).toByte() }.toByteArray() }
        val okm = LinkshellCrypto.hkdf(hex("0b".repeat(22)), hex("000102030405060708090a0b0c"), hex("f0f1f2f3f4f5f6f7f8f9"), 42)
        assertEquals("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865", okm.joinToString("") { "%02x".format(it) })
    }

    @Test fun sealRoundTripAndPairCode() {
        val k = phoneKey()
        val (iv, ct) = LinkshellCrypto.seal(k, linkId, "phone", "id-1234567", "pullbacks.scan", """{"i":3}""")
        assertEquals("""{"i":3}""", LinkshellCrypto.open(k, linkId, "phone", "id-1234567", "pullbacks.scan", iv, ct))
        assertEquals(22, LinkshellCrypto.newId().length)
        assertEquals(PairCode(900, "0123456789abcdef0123456789abcdef", "AbCdEfGhIjKlMnOpQrStUv"), PairCode.parse(" LS1.900.0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOpQrStUv "))
        assertNull(PairCode.parse("110318-0000002441"))
        assertNull(PairCode.parse("LS1.900.0123456789ABCDEF0123456789abcdef.AbCdEfGhIjKlMnOpQrStUv"))
    }

    // ---------------------------------------------------------------- the connection
    private class FakeSocket(val url: String, val protocols: List<String>, val l: LsSocketListener) : LsSocket {
        val sent = mutableListOf<String>()
        var closed: Int? = null
        override fun send(text: String) = sent.add(text)
        override fun close(code: Int, reason: String) { closed = code }
        fun frames() = sent.filter { it != "ping" }.map { LinkpearlJson.parseToJsonElement(it).jsonObject }
    }

    private class Rig(scope: TestScope, store: LinkshellStore) {
        val sockets = mutableListOf<FakeSocket>()
        val client = LinkshellClient(
            store, { url, p, l -> FakeSocket(url, p, l).also { sockets += it } }, "https://tracker.example.test",
            { Credentials("a".repeat(32), "b".repeat(64)) }, scope.backgroundScope, now = { scope.testScheduler.currentTime },
            lane = StandardTestDispatcher(scope.testScheduler),
        )
    }

    private fun link() = StoredLink(linkId, 900, "Chrome · Mac", Base64.getEncoder().encodeToString(phoneKey()))
    private fun fromPc(id: String, kind: String, body: String): String {
        val (iv, ct) = LinkshellCrypto.seal(phoneKey(), linkId, "pc", id, kind, body)
        return buildJsonObject { put("t", "msg"); put("id", id); put("kind", kind); put("iv", iv); put("ct", ct) }.toString()
    }

    @Test fun deliveryRules() = runTest {
        val store = MemoryLinkshellStore(LinkshellData(link = link()))
        val r = Rig(this, store)
        val got = mutableListOf<String>()
        r.client.on("pullbacks.result") { got += it.id }
        // a send connects, and waits in the outbox until the browser acks it
        val id = r.client.send("pullbacks.scan", buildJsonObject { put("i", 0) })
        runCurrent()
        val ws = r.sockets.single()
        assertEquals("wss://tracker.example.test/v1/linkshell/connect?link=$linkId", ws.url)
        assertEquals(listOf("linkshell", "ph.${"a".repeat(32)}.${"b".repeat(64)}"), ws.protocols)
        ws.l.onOpen(); runCurrent()
        assertTrue(r.client.state.value.online)
        val f = ws.frames().single()
        assertEquals(id, f.s("id"))
        assertEquals("""{"i":0}""", LinkshellCrypto.open(phoneKey(), linkId, "phone", id, "pullbacks.scan", f.s("iv"), f.s("ct")))
        ws.l.onMessage("""{"t":"hello","peer":true,"seen":null}"""); runCurrent()
        assertTrue(r.client.state.value.peer)
        assertEquals(2, ws.frames().size) // hello resends what isn't acked
        ws.l.onMessage("""{"t":"ack","ids":["$id"]}"""); runCurrent()
        assertTrue(store.data.outbox.isEmpty())
        // a message from the browser: handled once, acked every time; one that doesn't open is dropped and acked
        ws.sent.clear()
        val m = fromPc("res-0000001", "pullbacks.result", """{"run":"r","i":0,"state":"marked"}""")
        ws.l.onMessage(m); ws.l.onMessage(m); runCurrent()
        ws.l.onMessage(fromPc("res-0000002", "pullbacks.result", "{}").replace("pullbacks.result", "pullbacks.end")); runCurrent()
        assertEquals(listOf("res-0000001"), got)
        assertEquals(listOf("res-0000001", "res-0000001", "res-0000002"), ws.frames().map { it["ids"]!!.jsonArray.single().let { e -> (e as JsonPrimitive).content } })
        // pings without counting as use; idle close after 5 minutes; no reconnect until woken
        ws.sent.clear()
        advanceTimeBy(4 * 60_000L + 1); runCurrent()
        assertTrue("ping" in ws.sent)
        ws.l.onMessage("pong")
        advanceTimeBy(61_000L); runCurrent()
        assertEquals(1000, ws.closed)
        assertTrue(!r.client.state.value.online)
        advanceTimeBy(10 * 60_000L); runCurrent()
        assertEquals(1, r.sockets.size)
        r.client.wake(); runCurrent()
        assertEquals(2, r.sockets.size)
        // a dropped connection retries; 4000 (connected elsewhere) doesn't; 4001 (unlinked) forgets the link
        r.sockets[1].l.onClosed(1006); runCurrent()
        advanceTimeBy(2_001L); runCurrent()
        assertEquals(3, r.sockets.size)
        r.sockets[2].l.onClosed(4000); runCurrent()
        advanceTimeBy(120_000L); runCurrent()
        assertEquals(3, r.sockets.size)
        r.client.wake(); runCurrent()
        r.sockets[3].l.onClosed(4001); runCurrent()
        assertNull(store.data.link)
        assertNull(r.client.state.value.link)
    }

    @Test fun aRefusedPhoneKeepsItsLinkAndStopsRetryingUntilWoken() = runTest {
        val store = MemoryLinkshellStore(LinkshellData(link = link()))
        val r = Rig(this, store)
        assertEquals(LS_CLOSE_REFUSED, OkHttpSockets.closeCodeFor(401))
        assertEquals(LS_CLOSE_REFUSED, OkHttpSockets.closeCodeFor(403))
        assertEquals(4001, OkHttpSockets.closeCodeFor(404))
        assertEquals(1006, OkHttpSockets.closeCodeFor(503))
        assertEquals(1006, OkHttpSockets.closeCodeFor(null))
        // deactivated, or its token no longer valid: the relay answers 401 to the connect
        r.client.wake(); runCurrent()
        r.sockets[0].l.onClosed(LS_CLOSE_REFUSED); runCurrent()
        advanceTimeBy(10 * 60_000L); runCurrent()
        assertEquals(1, r.sockets.size)
        assertNotNull(store.data.link)
        assertNotNull(r.client.state.value.link)
        assertTrue(!r.client.state.value.online)
        // also when it follows ordinary drops (a retry was already counting up)
        r.client.wake(); runCurrent()
        r.sockets[1].l.onClosed(1006); runCurrent()
        advanceTimeBy(2_001L); runCurrent()
        r.sockets[2].l.onClosed(LS_CLOSE_REFUSED); runCurrent()
        advanceTimeBy(10 * 60_000L); runCurrent()
        assertEquals(3, r.sockets.size)
        // a send tries again, and its message is still waiting when the phone is let back in
        val id = r.client.send("pullbacks.scan", buildJsonObject { put("i", 0) }); runCurrent()
        assertEquals(4, r.sockets.size)
        r.sockets[3].l.onOpen(); runCurrent()
        assertTrue(r.client.state.value.online)
        assertEquals(id, r.sockets[3].frames().single().s("id"))
    }

    // ---------------------------------------------------------------- pairing
    private class FakeApi(val answers: MutableMap<String, ApiResult<JsonElement>> = mutableMapOf()) : ApiClient {
        val posts = mutableListOf<Pair<String, JsonElement?>>()
        override suspend fun get(path: String, query: Map<String, String>) = answers[path] ?: ApiResult.Failure(ApiError.NotFound, 404)
        override suspend fun post(path: String, body: JsonElement?): ApiResult<JsonElement> { posts += path to body; return answers[path] ?: ApiResult.Failure(ApiError.NotFound, 404) }
        override suspend fun put(path: String, body: JsonElement?) = ApiResult.Failure(ApiError.NotFound, 404)
        override suspend fun delete(path: String) = ApiResult.Failure(ApiError.NotFound, 404)
    }

    @Test fun pairing() = runTest {
        val api = FakeApi()
        val phone: KeyPair = LinkshellCrypto.newPairKey()
        api.answers["/v1/agents/m/linkshell/pair"] = ApiResult.Success(buildJsonObject { put("linkId", linkId); put("store", 900); put("pcName", "Chrome · Mac"); put("pcJwk", pcPub) })
        val store = MemoryLinkshellStore()
        val r = Rig(this, store)
        val vm = LinkshellViewModel(r.client, LinkshellRepository(api) { phone }, null, now = { testScheduler.currentTime })
        vm.onCode("110318-0000002441") // not a pairing code
        assertTrue(api.posts.isEmpty())
        vm.onCode("LS1.900.0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOpQrStUv"); runCurrent()
        val sentKey = (api.posts.single().second as JsonObject)["publicJwk"]!!.jsonObject
        assertEquals(P256.jwk(phone.public as ECPublicKey), sentKey)
        val check = vm.state.value as LsUi.Check
        assertEquals(LinkshellCrypto.checkCode(pcPub, sentKey), check.code)
        // waits for Link on the browser: the link shows up in this phone's list
        advanceTimeBy(4_100L); runCurrent()
        assertTrue(vm.state.value is LsUi.Check)
        api.answers["/v1/agents/m/linkshell/links"] = ApiResult.Success(buildJsonObject { put("links", LinkpearlJson.parseToJsonElement("""[{"id":"$linkId","store":900}]""")) })
        advanceTimeBy(2_100L); runCurrent()
        val saved = assertNotNull(store.data.link).let { store.data.link!! }
        assertEquals(linkId, saved.linkId)
        assertEquals(LinkshellCrypto.linkKey(phone, pcPub, linkId).toList(), Base64.getDecoder().decode(saved.key).toList())
        assertTrue(vm.state.value is LsUi.Linked)
        // expired codes say so
        api.answers.remove("/v1/agents/m/linkshell/pair")
        val vm2 = LinkshellViewModel(Rig(this, MemoryLinkshellStore()).client, LinkshellRepository(api), null)
        vm2.onCode("LS1.900.0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOpQrStUv"); runCurrent()
        assertEquals(LsUi.Scan(error = "Code expired"), vm2.state.value)
    }

    // ---------------------------------------------------------------- a Pullbacks run from the browser
    @Test fun joinedRun() = runTest {
        val r = Rig(this, MemoryLinkshellStore(LinkshellData(link = link())))
        val pb = PullbackLink(r.client)
        r.client.wake(); runCurrent()
        val ws = r.sockets.single(); ws.l.onOpen(); runCurrent()
        val rows = (0 until 45).joinToString(",") { """[$it,"1000$it","Part $it","S-$it","${if (it == 1) "marked" else "pending"}"]""" }
        val all = LinkpearlJson.parseToJsonElement("[$rows]").jsonArray
        ws.l.onMessage(fromPc("run-part-1", "pullbacks.run", """{"run":"r1","file":"Pullback Serials.xlsx","store":"900","part":1,"parts":2,"items":${all.drop(40)}}""")); runCurrent()
        assertNull(pb.offer.value)
        ws.l.onMessage(fromPc("run-part-0", "pullbacks.run", """{"run":"r1","file":"Pullback Serials.xlsx","store":"900","part":0,"parts":2,"items":${all.take(40)}}""")); runCurrent()
        val run = assertNotNull(pb.offer.value).let { pb.offer.value!! }
        assertEquals(45, run.total)
        assertEquals(1, run.done)

        var s = PbSession.fromRun(run)
        assertEquals("r1", s.link)
        assertEquals(PbStatus.Matched, s.items[1].status)
        assertEquals("success", s.items[1].backendStatus)
        assertEquals(0, s.idx)
        // scanned here: sending until the browser answers; its answer wins, except "pending" over a scan on its way
        s = s.scan("s-0").let { it.sent(it.history.last()) }
        assertEquals(PbSession.SENDING, s.items[0].backendStatus)
        assertEquals(PbStatus.Matched, s.pcResult(0, PcState.Pending).items[0].status)
        s = s.pcResult(0, PcState.Queued)
        assertEquals(1, s.sending)
        s = s.pcResult(0, PcState.Marked)
        assertEquals("success", s.items[0].backendStatus)
        assertEquals(2, s.idx)
        // undone on the browser: back to pending, and the phone goes back to it
        s = s.pcResult(1, PcState.Pending)
        assertEquals(PbStatus.Pending, s.items[1].status)
        // ended there: the browser closes the run
        ws.l.onMessage(fromPc("end-0000001", "pullbacks.end", """{"run":"r1"}""")); runCurrent()
        assertNull(pb.offer.value)
        // the phone's messages
        ws.sent.clear()
        pb.scan("r1", 2, "S-2", override = false); runCurrent()
        val f = ws.frames().single()
        assertEquals("pullbacks.scan", f.s("kind"))
        assertEquals("""{"run":"r1","i":2,"serial":"S-2","override":false}""", LinkshellCrypto.open(phoneKey(), linkId, "phone", f.s("id"), "pullbacks.scan", f.s("iv"), f.s("ct")))
        assertEquals(PcRun("x", "", "", listOf(PcItem(0, "", "", "", PcState.Failed))).done, 1)
    }

    @Test fun buybackRun() = runTest {
        val r = Rig(this, MemoryLinkshellStore(LinkshellData(link = link())))
        val bb = BuybackLink(r.client)
        r.client.wake(); runCurrent()
        val ws = r.sockets.single(); ws.l.onOpen(); runCurrent()
        ws.l.onMessage("""{"t":"hello","peer":true,"seen":null}"""); runCurrent()
        ws.l.onMessage(fromPc("bb-run-0", "buybacks.run", """{"run":"b1","order":"0000000001","store":"900","part":0,"parts":1,"items":[[0,"B-100000-0000000001","Test Destination (TLC)","pending"],[1,"B-100000-0000000002","UROC","pending"]]}""")); runCurrent()
        val run = bb.offer.value!!
        assertEquals(2, run.total)
        assertEquals("TLC", Buybacks.shortDestination(run.items[0].destination))
        assertEquals("UROC", Buybacks.shortDestination(run.items[1].destination))
        bb.join(run)
        val vm = BuybackViewModel(bb); runCurrent()
        var ui = vm.state.value as BbUi.Scanning
        assertTrue(ui.pc)
        assertEquals(2, ui.toScan.size)
        // the camera ignores anything but a B- label; typed, it says so
        ws.sent.clear()
        vm.onCode("110318-0000002441"); runCurrent()
        assertTrue(ws.frames().isEmpty())
        vm.onCode("110318-0000002441", typed = true)
        assertEquals("110318-0000002441", (vm.state.value as BbUi.Scanning).notLabel)
        // a label goes once (the list's spelling), Sending until the browser answers
        vm.onCode("b-100000-0000000001"); vm.onCode("B-100000-0000000001"); runCurrent()
        val f = ws.frames().single()
        assertEquals("buybacks.scan", f.s("kind"))
        assertEquals("""{"run":"b1","label":"B-100000-0000000001"}""", LinkshellCrypto.open(phoneKey(), linkId, "phone", f.s("id"), "buybacks.scan", f.s("iv"), f.s("ct")))
        ui = vm.state.value as BbUi.Scanning
        assertEquals(BbScanState.Sending, ui.last!!.state)
        assertEquals(1, ui.toScan.size)
        // Portal's message on a failure; a failed label can be scanned again
        ws.l.onMessage(fromPc("bb-res-1", "buybacks.result", """{"run":"b1","label":"B-100000-0000000001","i":0,"state":"failed","message":"Not eligible"}""")); runCurrent()
        ui = vm.state.value as BbUi.Scanning
        assertEquals(BbScanState.Failed, ui.last!!.state)
        assertEquals("Not eligible", ui.last!!.message)
        ws.sent.clear()
        vm.onCode("B-100000-0000000001"); runCurrent()
        assertEquals(1, ws.frames().size)
        ws.l.onMessage(fromPc("bb-res-2", "buybacks.result", """{"run":"b1","label":"B-100000-0000000001","i":0,"state":"added"}""")); runCurrent()
        ui = vm.state.value as BbUi.Scanning
        assertEquals(BbScanState.Added, ui.last!!.state)
        assertEquals(1, ui.run.added)
        assertEquals(1, bb.offer.value!!.added)
        // a label that isn't in the list still gets the browser's answer
        ws.l.onMessage(fromPc("bb-res-3", "buybacks.result", """{"run":"b1","label":"B-999999-0000000009","i":-1,"state":"failed","message":"Not eligible"}""")); runCurrent()
        assertEquals("B-999999-0000000009", (vm.state.value as BbUi.Scanning).last!!.label)
        // stopped on the PC
        ws.l.onMessage(fromPc("bb-end-1", "buybacks.end", """{"run":"b1"}""")); runCurrent()
        assertNull(bb.offer.value)
        assertEquals(BbUi.None(stopped = true), vm.state.value)
        assertTrue(Buybacks.isLabel("B-660482-0000012671"))
        assertTrue(!Buybacks.isLabel("I-0017390417"))
    }

    // ---------------------------------------------------------------- a morning check list from the browser
    @Test fun morningCheckListFromAnotherStoreIsNotShown() = runTest {
        val r = Rig(this, MemoryLinkshellStore(LinkshellData(link = link()))) // linked to store 900
        val mc = MorningCheckLink(r.client)
        val ended = mutableListOf<Pair<String, String>>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { mc.ended.collect { ended += it } }
        r.client.wake(); runCurrent()
        val ws = r.sockets.single(); ws.l.onOpen(); runCurrent()
        fun list(id: String, run: String, store: String, part: Int, parts: Int, wo: String) = fromPc(id, "check.list",
            """{"run":"$run","store":"$store","bins":false,"statuses":[[8,"Ready for work",[9]]],"part":$part,"parts":$parts,"rows":[["$wo",8,"B2","","Phone","Screen","Sam Doe","Retail","u1"]]}""")
        // Portal on the PC is on another store: nothing is shown, the check ends here and the browser is told
        ws.sent.clear()
        ws.l.onMessage(list("chk-list-01", "c1", "914", 0, 1, "700001")); runCurrent()
        assertNull(mc.list.value)
        assertEquals(listOf("c1" to "store"), ended)
        val f = ws.frames().single { it["t"] == JsonPrimitive("msg") }
        assertEquals("check.end", f.s("kind"))
        assertEquals("""{"run":"c1"}""", LinkshellCrypto.open(phoneKey(), linkId, "phone", f.s("id"), "check.end", f.s("iv"), f.s("ct")))
        // the link's own store, in two parts arriving out of order: shown once complete, rows in part order
        ws.l.onMessage(list("chk-list-02", "c2", "900", 1, 2, "700002")); runCurrent()
        assertNull(mc.list.value)
        ws.l.onMessage(list("chk-list-03", "c2", "900", 0, 2, "700001")); runCurrent()
        assertEquals(listOf("700001", "700002"), mc.list.value!!.rows.map { it.wo })
        assertEquals("900", mc.list.value!!.store)
        assertEquals(1, ended.size)
    }
}
