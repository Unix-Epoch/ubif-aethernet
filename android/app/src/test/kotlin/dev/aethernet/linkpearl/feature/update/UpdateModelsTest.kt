package dev.aethernet.linkpearl.feature.update

import dev.aethernet.linkpearl.core.data.Credentials
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class UpdateModelsTest {
    @get:Rule val tmp = TemporaryFolder()

    // ---- the server's answer (real output quoted in tracker-worker/MOBILE-API-update.md)

    @Test fun parsesTheDocumentedAnswer() {
        val a = UpdateAnswer.parse(Json.parseToJsonElement(
            """{"latest":{"code":6,"name":"1.2.0","size":300000,"sha256":"1b28064f4d6462f8e9116e726b0171876a2f81cd261f02c179c5d0c75c3effc4","notes":"Prices and in-app updates."},"min":{"code":1,"name":"1.0.0"}}""",
        ))!!
        assertEquals(6, a.latest!!.code)
        assertEquals(300000L, a.latest!!.size)
        assertEquals("Prices and in-app updates.", a.latest!!.notes)
        assertEquals(MinVersion(1, "1.0.0"), a.min)
    }

    @Test fun nothingPublished() {
        val a = UpdateAnswer.parse(Json.parseToJsonElement("""{"latest":null,"min":{"code":1,"name":"1.0.0"}}"""))!!
        assertNull(a.latest)
        assertEquals(1, a.min!!.code)
    }

    @Test fun aLatestThatCannotBeVerifiedIsDroppedButMinStays() {
        val bad = UpdateAnswer.parse(Json.parseToJsonElement("""{"latest":{"code":6,"name":"1.2.0","size":300000,"sha256":"nothex"},"min":{"code":2,"name":"1.0.1"}}"""))!!
        assertNull(bad.latest)
        assertEquals(2, bad.min!!.code)
        val broken = UpdateAnswer.parse(Json.parseToJsonElement("""{"latest":{"code":"x"},"min":{"code":2,"name":"1.0.1"}}"""))!!
        assertNull(broken.latest)
        assertEquals(2, broken.min!!.code)
        assertNull(UpdateAnswer.parse(Json.parseToJsonElement("[]")))
    }

    // ---- verify

    @Test fun sha256OfKnownBytes() {
        val f = File(tmp.root, "abc").apply { writeText("abc") }
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", ApkVerify.sha256Hex(f))
    }

    @Test fun verifyNeedsBothSizeAndHash() {
        val f = File(tmp.root, "a.apk").apply { writeBytes(ApkBytes) }
        assertTrue(ApkVerify.matches(f, Release120))
        assertTrue(ApkVerify.matches(f, Release120.copy(sha256 = Release120.sha256.uppercase())))
        assertFalse(ApkVerify.matches(f, Release120.copy(size = Release120.size + 1)))
        assertFalse(ApkVerify.matches(f, Release120.copy(sha256 = "0".repeat(64))))
        assertFalse(ApkVerify.matches(File(tmp.root, "missing.apk"), Release120))
    }

    @Test fun progressText() {
        assertEquals("2.5 of 4.1 MB", UpdateFmt.progress(2_540_000, 4_100_000))
        assertEquals("62%", UpdateFmt.percent(UpdatePhase.Downloading(2_540_000, 4_100_000).fraction))
        assertEquals("0%", UpdateFmt.percent(UpdatePhase.Downloading(0, 0).fraction))
        assertEquals("4.1 of 4.1 MB", UpdateFmt.progress(5_000_000, 4_100_000))
    }

    @Test fun requiredUsesOwnCodeAgainstMin() {
        assertFalse(UpdateState(Current, min = MinVersion(4, "1.1.1")).required)
        assertTrue(UpdateState(Current, min = MinVersion(5, "1.1.2")).required)
        assertFalse(UpdateState(Current).required)
    }

    // ---- the real downloader against a local server

    private fun downloader(server: MockWebServer) = OkHttpApkDownloader(
        baseUrl = server.url("/").toString(), appKey = "app-key", credentials = { Credentials("dev1", "tok") },
        userAgent = "Linkpearl/1.1.1", appVersion = "1.1.1+4", allowLoopbackHttp = true,
    )

    @Test fun downloadsWithTheAppHeadersAndReportsProgress() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(200).setBody(Buffer().write(ApkBytes)))
            server.start()
            val out = File(tmp.root, "x.apk")
            val seen = mutableListOf<Long>()
            assertTrue(downloader(server).download(Release120, out) { seen += it })
            val req = server.takeRequest()
            assertEquals("/v1/agents/m/update/apk?code=6", req.path)
            assertEquals("app-key", req.getHeader("x-aethernet-key"))
            assertEquals("Bearer dev1.tok", req.getHeader("authorization"))
            assertEquals("1.1.1+4", req.getHeader("x-linkpearl-version"))
            assertTrue(ApkVerify.matches(out, Release120))
            assertEquals(ApkBytes.size.toLong(), seen.last())
        }
    }

    @Test fun refusesAnErrorAnswerOrMoreBytesThanAnnounced() = runTest {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"no such build"}"""))
            server.enqueue(MockResponse().setResponseCode(200).setBody(Buffer().write(ApkBytes + ByteArray(10))))
            server.start()
            val d = downloader(server)
            assertFalse(d.download(Release120, File(tmp.root, "a.apk")) {})
            assertFalse(d.download(Release120, File(tmp.root, "b.apk")) {})
        }
    }

    @Test fun plainHttpToAnotherHostIsRefused() = runTest {
        val d = OkHttpApkDownloader("http://example.com/", "k", { Credentials("a", "b") }, "ua", "v")
        assertFalse(d.download(Release120, File(tmp.root, "c.apk")) {})
    }
}
