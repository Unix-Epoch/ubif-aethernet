package dev.aethernet.linkpearl.core.data

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class RealHomeRepositoryTest {
    private val HOME = "GET /v1/agents/m/home"
    private val servers = mutableListOf<MockWebServer>()
    @After fun stop() = servers.forEach { runCatching { it.shutdown() } }

    private fun repo(script: Script, cache: File? = null, onStores: (List<StoreRef>) -> Unit = {}): Pair<RealHomeRepository, MockWebServer> {
        val srv = mockServer(script).also(servers::add)
        return RealHomeRepository(srv.client(credentials = { Credentials("a".repeat(32), "b".repeat(64)) }), cache?.let { EncryptedFile(it, testBox) }, onStores) to srv
    }

    private fun ok(r: HomeResult) = r as HomeResult.Ok
    private fun failed(r: HomeResult) = (r as HomeResult.Failed).reason

    @Test fun oneStoreDecodesTheRealAnswerAndAsksForTheRightThing() = runBlocking {
        val script = Script(HOME to listOf(MockResponse().answer("home-one")))
        val (repo, _) = repo(script)
        val d = ok(repo.load(StoreScope.One(914), fresh = true)).data
        assertEquals("/v1/agents/m/home?store=914&fresh=1", script.seen.single().path)
        assertEquals(listOf(326, 914), d.stores.map { it.id }); assertEquals("Newport News", d.stores[1].name)
        assertEquals("America/New_York", d.tz); assertEquals(7, d.days.size); assertEquals(d.days.last(), d.today)
        assertEquals(1800.0, d.sales.today!!, 0.0); assertEquals(1910.0, d.sales.yesterday!!, 0.0); assertEquals(7, d.sales.week.size)
        assertEquals(150.0, d.splh.today!!, 0.0); assertEquals(12.0, d.splh.hours!!, 0.0); assertEquals(listOf(160, 180), d.splh.target)
        assertEquals(485.0, d.rfp.total!!, 0.0); assertEquals(2, d.rfp.count); assertEquals(12, d.rfp.oldestDays); assertEquals(5, d.rfp.ages.size)
        assertEquals(Lanes(order = 1, start = 0, work = 1, wait = 0, rfp = 1, total = 3), d.lanes)
        assertEquals(14, d.cleaning.cln); assertEquals(18, d.cleaning.am); assertEquals(0.78, d.cleaning.rate!!, 0.0)
        assertNull(d.byStore); assertNull(d.behind); assertFalse(d.stale); assertFalse(d.empty)
    }

    @Test fun allStoresHasByStoreAndNullsStayNull() = runBlocking {
        val script = Script(HOME to listOf(MockResponse().answer("home-all")))
        val (repo, _) = repo(script)
        val d = ok(repo.load(StoreScope.All)).data
        assertEquals("/v1/agents/m/home?store=all", script.seen.single().path) // no fresh unless asked
        assertEquals(2, d.byStore!!.size); assertEquals(setOf(326, 914), d.byStore!!.map { it.id }.toSet())
        assertTrue(d.stale); assertEquals(326, d.behind!!.id)
        assertEquals(1800.0, d.sales.today!!, 0.0) // only store 914 has data, and 326 adds nothing
        assertNull(d.byStore!!.first { it.id == 326 }.sales) // a store with no data is a dash, not 0
    }

    @Test fun emptyAnswerIsHandledAndNotCached() = runBlocking {
        val script = Script(HOME to listOf(MockResponse().answer("home-empty"), MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.NO_RESPONSE)))
        val (repo, srv) = repo(script)
        val d = ok(repo.load(StoreScope.All)).data
        assertTrue(d.empty); assertEquals(emptyList<StoreRef>(), d.stores)
        srv.shutdown()
        assertEquals(FailureReason.Offline, failed(repo.load(StoreScope.All)))
    }

    @Test fun offlineReturnsTheLastGoodAnswerAndAnewRepositoryReadsItFromDisk() = runBlocking {
        val cacheFile = File(tempDir(), "home.bin")
        val script = Script(HOME to listOf(MockResponse().answer("home-one")))
        val (repo, srv) = repo(script, cacheFile)
        val live = ok(repo.load(StoreScope.One(914)))
        assertFalse(live.cached)
        srv.shutdown()
        val offline = ok(repo.load(StoreScope.One(914)))
        assertTrue(offline.cached); assertEquals(live.data, offline.data); assertEquals(live.data.asOf, offline.data.asOf) // dated by its own scan time
        assertEquals("another scope was never fetched", FailureReason.Offline, failed(repo.load(StoreScope.One(326))))

        // after a restart (new repository, same encrypted file)
        val srv2 = mockServer(Script()).also { servers += it }; val client = srv2.client(); srv2.shutdown()
        val restarted = RealHomeRepository(client, EncryptedFile(cacheFile, testBox))
        assertEquals(live.data, ok(restarted.load(StoreScope.One(914))).data); assertTrue(ok(restarted.load(StoreScope.One(914))).cached)
        assertFalse(String(cacheFile.readBytes(), Charsets.ISO_8859_1).contains("Newport News")) // encrypted at rest
        restarted.clear()
        assertFalse(cacheFile.exists()); assertEquals(FailureReason.Offline, failed(restarted.load(StoreScope.One(914))))
    }

    @Test fun serverTroubleDoesNotPretendToBeOffline() = runBlocking {
        val script = Script(HOME to listOf(MockResponse().answer("home-one"), MockResponse().setResponseCode(500).setBody("""{"error":"server error (id 9)"}"""), MockResponse().setResponseCode(429).setBody("""{"error":"slow down"}"""), MockResponse().setBody("""{"v":1,"sales":"oops"}""")))
        val (repo, _) = repo(script)
        ok(repo.load(StoreScope.All))
        assertEquals(FailureReason.Server, failed(repo.load(StoreScope.All)))
        assertEquals(FailureReason.Server, failed(repo.load(StoreScope.All)))
        assertEquals("an answer of the wrong shape", FailureReason.Server, failed(repo.load(StoreScope.All)))
    }

    @Test fun authAndStoreRefusalsMapToTheirOwnReasons() = runBlocking {
        for ((name, reason) in listOf("wrong-token" to FailureReason.Unauthorized, "home-not-approved" to FailureReason.Unauthorized, "home-not-your-store" to FailureReason.NotYourStore, "home-bad-store" to FailureReason.Server)) {
            val (repo, _) = repo(Script(HOME to listOf(MockResponse().answer(name))))
            assertEquals(name, reason, failed(repo.load(StoreScope.One(536))))
        }
    }

    @Test fun theStoreListIsPassedOn() = runBlocking {
        var seen: List<StoreRef> = emptyList()
        val (repo, _) = repo(Script(HOME to listOf(MockResponse().answer("home-all"))), onStores = { seen = it })
        repo.load(StoreScope.All)
        assertEquals(listOf(326, 914), seen.map { it.id })
    }

    @Test fun unknownFieldsAndMissingOnesAreTolerated() = runBlocking {
        val (repo, _) = repo(Script(HOME to listOf(MockResponse().setBody("""{"v":2,"scope":"all","stores":[{"id":1,"name":null,"extra":1}],"newThing":{"a":1}}"""))))
        val d = ok(repo.load(StoreScope.All)).data
        assertEquals(StoreRef(1, null), d.stores.single()); assertNull(d.sales.today)
    }
}
