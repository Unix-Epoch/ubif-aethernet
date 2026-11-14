package dev.aethernet.linkpearl.feature.workorders

import android.content.Intent
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PortalLinkTest {
    private val base = "https://portal.ubreakifix.net/repair/workorder/"

    @Test fun plainUrl() = assertEquals("7000001", PortalLink.numberIn("${base}7000001"))
    @Test fun whatTheAppBuilds() = assertEquals("7000001", PortalLink.numberIn(WoFmt.portalUrl(7000001)))
    @Test fun trailingSlash() = assertEquals("7000001", PortalLink.numberIn("${base}7000001/"))
    @Test fun query() = assertEquals("7000001", PortalLink.numberIn("${base}7000001?tab=notes&x=1"))
    @Test fun fragment() = assertEquals("7000001", PortalLink.numberIn("${base}7000001#history"))
    @Test fun slashQueryFragment() = assertEquals("7000001", PortalLink.numberIn("${base}7000001/?a=b#c"))
    @Test fun hostCaseIgnored() = assertEquals("42", PortalLink.numberIn("https://Portal.UBreakiFix.net/repair/workorder/42"))

    @Test fun embeddedInText() {
        assertEquals("7000001", PortalLink.numberIn("Please look at ${base}7000001 before noon, thanks"))
        assertEquals("7000001", PortalLink.numberIn("Please look at ${base}7000001."))
        assertEquals("7000001", PortalLink.numberIn("(${base}7000001)"))
        assertEquals("7000001", PortalLink.numberIn("WO:\n${base}7000001\nbye"))
    }

    @Test fun firstOfSeveral() = assertEquals("1", PortalLink.numberIn("${base}1 and ${base}2"))

    @Test fun wrongHost() {
        assertNull(PortalLink.numberIn("https://portal.example.com/repair/workorder/7000001"))
        assertNull(PortalLink.numberIn("https://evil-portal.ubreakifix.net/repair/workorder/7000001"))
        assertNull(PortalLink.numberIn("https://portal.ubreakifix.net.evil.com/repair/workorder/7000001"))
    }

    @Test fun wrongScheme() = assertNull(PortalLink.numberIn("http://portal.ubreakifix.net/repair/workorder/7000001"))

    @Test fun wrongPath() {
        assertNull(PortalLink.numberIn("https://portal.ubreakifix.net/repair/workorders/7000001"))
        assertNull(PortalLink.numberIn("https://portal.ubreakifix.net/workorder/7000001"))
        assertNull(PortalLink.numberIn("https://portal.ubreakifix.net/repair/workorder/7000001/edit"))
        assertNull(PortalLink.numberIn("https://portal.ubreakifix.net/repair/workorder/"))
    }

    @Test fun nonNumeric() {
        assertNull(PortalLink.numberIn("${base}abc"))
        assertNull(PortalLink.numberIn("${base}7000001abc"))
        assertNull(PortalLink.numberIn("${base}-5"))
    }

    @Test fun noText() {
        assertNull(PortalLink.numberIn(null))
        assertNull(PortalLink.numberIn(""))
        assertNull(PortalLink.numberIn("hello"))
    }

    @Test fun mapsOntoTheExistingDeepLinkPath() {
        assertEquals("linkpearl://workorders/7000001", PortalLink.deepLink("${base}7000001/?x=1"))
        assertNull(PortalLink.deepLink("nothing here"))
    }

    @Test fun deepLinkForIntentShapes() {
        val u = "${base}7000001"
        assertEquals("linkpearl://workorders/7000001", PortalLink.deepLinkFor(Intent.ACTION_VIEW, u, null, null))
        assertEquals("linkpearl://workorders/7000001", PortalLink.deepLinkFor(Intent.ACTION_SEND, null, "text/plain", "look: $u"))
        assertNull(PortalLink.deepLinkFor(Intent.ACTION_SEND, null, "text/plain", "no link"))
        assertNull(PortalLink.deepLinkFor(Intent.ACTION_SEND, null, "image/png", u))
        assertNull(PortalLink.deepLinkFor(Intent.ACTION_MAIN, u, null, u))
        assertNull(PortalLink.deepLinkFor(Intent.ACTION_VIEW, "linkpearl://workorders/914-7000001", null, null))
    }

    @Test fun normalizeViewIntent() {
        val out = PortalLink.normalize(Intent(Intent.ACTION_VIEW, Uri.parse("${base}7000001/")))
        assertEquals(Intent.ACTION_VIEW, out.action)
        assertEquals("linkpearl://workorders/7000001", out.dataString)
    }

    @Test fun normalizeShareIntent() {
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "WO ${base}7000001 thanks")
        val out = PortalLink.normalize(send)
        assertEquals(Intent.ACTION_VIEW, out.action)
        assertEquals("linkpearl://workorders/7000001", out.dataString)
        assertNull(out.type)
    }

    @Test fun shareWithoutLinkAndOtherIntentsAreUntouched() {
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "just words")
        assertSame(send, PortalLink.normalize(send))
        val own = Intent(Intent.ACTION_VIEW, Uri.parse("linkpearl://alerts"))
        assertSame(own, PortalLink.normalize(own))
        val main = Intent(Intent.ACTION_MAIN)
        assertSame(main, PortalLink.normalize(main))
    }

    // Routing: which search result opens the detail.
    private val one = WoRow(store = 914, wo = 7000001)
    private fun search(q: String = "7000001", rows: List<WoRow> = listOf(one), busy: Boolean = false, problem: Problem? = null, lock: Boolean = false) =
        SearchUi(q, busy = busy, results = rows, needsUnlock = lock, problem = problem)

    @Test fun exactlyOneResultOpens() = assertEquals(WoKey(914, 7000001), PortalLink.singleResult("7000001", search()))
    @Test fun noOrManyResultsDoNotOpen() {
        assertNull(PortalLink.singleResult("7000001", search(rows = emptyList())))
        assertNull(PortalLink.singleResult("7000001", search(rows = listOf(one, WoRow(store = 915, wo = 7000001)))))
    }
    @Test fun unfinishedOrOtherSearchesDoNotOpen() {
        assertNull(PortalLink.singleResult("7000001", search(busy = true)))
        assertNull(PortalLink.singleResult("7000001", search(problem = Problem.Offline)))
        assertNull(PortalLink.singleResult("7000001", search(lock = true)))
        assertNull(PortalLink.singleResult("7000001", search(q = "123")))
        assertNull(PortalLink.singleResult("7000001", null))
        assertNull(PortalLink.singleResult(null, search()))
    }
    @Test fun bareNumberIsNotAStoreWoId() {
        assertTrue(PortalLink.isBareNumber("7000001"))
        assertTrue(!PortalLink.isBareNumber("914-7000001"))
        assertTrue(!PortalLink.isBareNumber(null))
        assertTrue(!PortalLink.isBareNumber(""))
    }

    // Loop guard: the browser choice never names Linkpearl.
    private val own = "dev.aethernet.linkpearl"
    @Test fun defaultBrowserWins() = assertEquals("org.mozilla.firefox", PortalLink.pickBrowser("org.mozilla.firefox", listOf("com.android.chrome", "org.mozilla.firefox"), own))
    @Test fun neverOurselvesOrTheResolver() {
        assertEquals("com.android.chrome", PortalLink.pickBrowser(own, listOf(own, "com.android.chrome"), own))
        assertEquals("com.android.chrome", PortalLink.pickBrowser("android", listOf("android", "com.android.chrome"), own))
        assertEquals("com.android.chrome", PortalLink.pickBrowser(null, listOf(own, "com.android.chrome"), own))
    }
    @Test fun noBrowserIsNull() {
        assertNull(PortalLink.pickBrowser(null, emptyList(), own))
        assertNull(PortalLink.pickBrowser(own, listOf(own), own))
    }
}
