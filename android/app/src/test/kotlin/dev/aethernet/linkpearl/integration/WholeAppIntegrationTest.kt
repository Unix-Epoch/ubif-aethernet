package dev.aethernet.linkpearl.integration

import dev.aethernet.linkpearl.BuildConfig
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.data.AuthState
import dev.aethernet.linkpearl.core.data.FailureReason
import dev.aethernet.linkpearl.core.data.HomeResult
import dev.aethernet.linkpearl.core.data.OkHttpApiClient
import dev.aethernet.linkpearl.core.data.RealAuth
import dev.aethernet.linkpearl.core.data.RealHomeRepository
import dev.aethernet.linkpearl.core.data.RealStoreKeys
import dev.aethernet.linkpearl.core.data.SoftwareIdentity
import dev.aethernet.linkpearl.core.data.StoreScope
import dev.aethernet.linkpearl.core.data.StoreZone
import dev.aethernet.linkpearl.core.data.newSessionStore
import dev.aethernet.linkpearl.core.lock.PromptResult
import dev.aethernet.linkpearl.core.lock.RealAppLock
import dev.aethernet.linkpearl.core.lock.SealedBox
import dev.aethernet.linkpearl.core.lock.UnlockPrompt
import dev.aethernet.linkpearl.core.nav.Routes
import dev.aethernet.linkpearl.feature.alerts.AlertType
import dev.aethernet.linkpearl.feature.alerts.AlertsHub
import dev.aethernet.linkpearl.feature.alerts.CheckOutcome
import dev.aethernet.linkpearl.feature.alerts.FakeNotifier
import dev.aethernet.linkpearl.feature.alerts.MemoryCheckState
import dev.aethernet.linkpearl.feature.alerts.SettingsEdit
import dev.aethernet.linkpearl.feature.alerts.SettingsUi
import dev.aethernet.linkpearl.feature.settings.SettingsViewModel
import dev.aethernet.linkpearl.feature.workorders.Card
import dev.aethernet.linkpearl.feature.workorders.CardMatch
import dev.aethernet.linkpearl.feature.workorders.IndexEntry
import dev.aethernet.linkpearl.feature.workorders.LaneFilter
import dev.aethernet.linkpearl.feature.workorders.ListQuery
import dev.aethernet.linkpearl.feature.workorders.Unsealed
import dev.aethernet.linkpearl.feature.workorders.WoKey
import dev.aethernet.linkpearl.feature.workorders.WoRepository
import dev.aethernet.linkpearl.feature.workorders.WoSort
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * The whole app data path against the REAL tracker Worker code (android/tools/local-server.mjs: local D1, nothing remote), using the real
 * app classes: register, approve, Home, work orders, sealed card and snapshot opened through the real lock and crypto with keys unwrapped
 * by a software device key, the server's alerts tick, the background check with a recording notifier, feed, read marks, thresholds,
 * the prefs route, "forget this phone", and the 401 after it.
 *
 * Skipped unless LINKPEARL_LOCAL_SERVER is set. `android/tools/run-integration.sh` starts the server (fresh database), runs this and stops it.
 * The server's clock is moved to Thursday Oct 15 2026, 4 PM Eastern (store hours) once Home has been read, so every rule can fire.
 */
class WholeAppIntegrationTest {
    private val base = System.getenv("LINKPEARL_LOCAL_SERVER")

    private fun control(path: String, json: String = "{}"): String {
        val r = OkHttpClient().newCall(Request.Builder().url(base + path).post(json.toRequestBody("application/json".toMediaType())).build()).execute()
        return r.use { val text = it.body.string(); assertEquals(path + " " + text, 200, it.code); text }
    }

    private suspend fun until(what: String, check: () -> Boolean) {
        withTimeout(10_000) { while (!check()) delay(20) }.also { assertTrue(what, check()) }
    }

    @Test fun wholeApp() = runBlocking {
        assumeTrue("LINKPEARL_LOCAL_SERVER not set", base != null)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try { run(scope) } finally { scope.cancel() }
    }

    private suspend fun run(scope: CoroutineScope) {
        // ---- a phone with a software device key, registered and approved for 914 and 326
        val store = newSessionStore()
        val identity = SoftwareIdentity(store)
        lateinit var auth: RealAuth
        val client = OkHttpApiClient(base!!, "k", { store.current.credentials }, { auth }, allowLoopbackHttp = true, appVersion = BuildConfig.VERSION_NAME + "+" + BuildConfig.VERSION_CODE)
        auth = RealAuth(store, client, identity, { identity.reset() }, scope = scope)
        assertTrue(auth.register("Integration phone"))
        control("/__ctl/approve", """{"id":"${store.current.deviceId}","stores":[914,326]}""")
        auth.refresh()
        assertEquals(listOf(914, 326), (auth.state.value as AuthState.Registered).stores.map { it.id })

        // ---- Home, and the store zone it reports
        val zone = StoreZone(store)
        val home = RealHomeRepository(client, onStores = { auth.rememberStoreNames(it) }, onZone = zone::remember)
        val all = (home.load(StoreScope.All, fresh = true) as HomeResult.Ok).data
        assertEquals(setOf(914, 326), all.stores.map { it.id }.toSet())
        assertEquals("America/New_York", all.tz); assertEquals("America/New_York", zone.id)
        assertEquals(HomeResult.Failed(FailureReason.NotYourStore), home.load(StoreScope.One(536)))
        val names = (auth.state.value as AuthState.Registered).stores.associate { it.id to it.name }
        assertEquals("Newport News", names[914]); assertEquals("Lynnhaven", names[326])

        // ---- move the server to Thursday 4 PM Eastern and put work orders in through the real upload route
        control("/__ctl/clock", """{"at":"2026-10-15T20:00:00Z"}""")
        control("/__ctl/seed-wo")

        // ---- the real lock: the system prompt is replaced by one that succeeds; keys are unwrapped with the software device key
        val lock = RealAppLock(
            scope = scope, storeKeys = { RealStoreKeys(store, auth) }, identity = { identity }, auth = { auth },
            prompt = UnlockPrompt { PromptResult.Success }, clock = { System.nanoTime() / 1_000_000 },
        )
        assertFalse(lock.isUnlocked.value); assertNull(lock.opener)

        // ---- work orders: list, then a sealed detail
        val wo = WoRepository(client)
        val list = (wo.list(ListQuery(store = null, filter = LaneFilter.All, sort = WoSort.Status)) as ApiResult.Success).value
        assertEquals(setOf(7000001L, 7000002L, 7000003L), list.rows.filter { it.store == 914 && it.wo >= 7000000 }.map { it.wo }.toSet())
        assertNull("no cards while locked", list.rows.first { it.wo == 7000001L }.card)
        assertEquals("Need to order", list.rows.first { it.wo == 7000001L }.status)

        lock.unlock()
        until("unlocked") { lock.isUnlocked.value }
        val opener = lock.opener!!
        assertTrue(opener.hasKey(914) && opener.hasKey(326))
        val key = WoKey(914, 7000001)
        val detail = (wo.detail(key, sealed = true) as ApiResult.Success).value
        val part = detail.sealed!!
        assertEquals("Need to order", detail.wo.status)
        val card = Card.from(opener.openJson(914, part.card!!, SealedBox.Aad.card(914, key.wo)))
        assertEquals("Jordan Reyes", card.name); assertEquals(listOf("7575550100"), card.phones); assertEquals(listOf("jordan.reyes@example.com"), card.emails)
        assertEquals("353000111222333", card.imei)
        val snapshot = opener.openJson(914, part.snapshot!!.sealed!!, SealedBox.Aad.snapshot(914, key.wo))
        val shown = Unsealed.from(card, snapshot, part.snapshot!!.fetchedAt)
        assertEquals(2, shown.notes.size); assertTrue(shown.notes.all { it.text.contains("Screen is cracked") }); assertTrue(shown.hasSnapshot)
        // a sealed value is bound to its work order: another one's binding does not open it
        assertTrue(runCatching { opener.openJson(914, part.card!!, SealedBox.Aad.card(914, 7000002)) }.isFailure)
        // the list with sealed cards builds the search index; a phone-number fragment finds the customer
        val withCards = (wo.list(ListQuery(store = 914, filter = LaneFilter.All, sort = WoSort.Status, cards = true)) as ApiResult.Success).value
        val index = withCards.rows.mapNotNull { r -> r.card?.let { IndexEntry(r, Card.from(opener.openJson(r.store, it, SealedBox.Aad.card(r.store, r.wo)))) } }
        assertTrue(index.size >= 3); assertEquals(3, CardMatch.search(index, "5550100").size)
        lock.lock(); assertFalse(lock.isUnlocked.value); assertNull(lock.opener)

        // ---- alerts: the first background check only remembers where "now" is
        val check = MemoryCheckState(); val notifier = FakeNotifier()
        val hub = AlertsHub(client, auth, check, notifier, scope)
        assertEquals(CheckOutcome.Done, hub.checker.run())
        assertNotNull(check.cursorValue); assertTrue(notifier.posted.isEmpty())
        val firstCursor = check.cursorValue

        // quiet hours cover 4 PM: the server holds everything back
        hub.settings.load(); until("settings") { hub.settings.state.value is SettingsUi.Ready }
        assertTrue(hub.settings.edit(SettingsEdit.QuietFrom("15:00")))
        until("from saved") { (hub.settings.state.value as SettingsUi.Ready).error == null }
        assertTrue(hub.settings.edit(SettingsEdit.QuietTo("17:00")))
        delay(500)
        val stats = control("/__ctl/seed-alerts")
        assertTrue(stats, stats.contains("\"created\":") && !stats.contains("\"created\":0"))
        hub.checker.run()
        assertTrue("held in quiet hours", notifier.posted.isEmpty()); assertEquals(firstCursor, check.cursorValue)

        // quiet hours off: one alert of each type notifies
        assertTrue(hub.settings.edit(SettingsEdit.QuietOn(false))); delay(500)
        assertEquals(CheckOutcome.Done, hub.checker.run())
        val byType = notifier.posted.associateBy { it.type }
        assertEquals(setOf(AlertType.Stuck, AlertType.Pickup, AlertType.Followup, AlertType.Quiet), byType.keys)
        val stuck = byType.getValue(AlertType.Stuck)
        assertEquals(914, stuck.store); assertEquals(7000002L, stuck.workOrder); assertEquals("Newport News", stuck.title)
        assertEquals("Work order 7000002 has been in Diagnostics for 3 days", stuck.text)
        assertEquals("workorders/914-7000002", Routes.workOrder(stuck.store, stuck.workOrder!!))
        val pickup = byType.getValue(AlertType.Pickup)
        assertTrue(pickup.text, pickup.text.contains("waited at Ready for pickup for over 7 days")); assertNull(pickup.workOrder)
        val followup = byType.getValue(AlertType.Followup)
        assertEquals("Follow-up due today on 7000003", followup.text); assertEquals(7000003L, followup.workOrder)
        val quiet = byType.getValue(AlertType.Quiet)
        assertEquals(326, quiet.store); assertEquals("Lynnhaven", quiet.title); assertEquals("No updates from Lynnhaven since 11:30 AM (store hours)", quiet.text)
        assertTrue(check.cursorValue!! > firstCursor!!)
        val posted = notifier.posted.size
        hub.checker.run(); assertEquals("a repeat poll has nothing new", posted, notifier.posted.size)

        // ---- feed, read marks
        hub.feed.refresh(seen = false); until("feed") { hub.feed.state.value.loaded }
        val feed = hub.feed.state.value
        assertTrue(feed.alerts.size >= 4); assertEquals(feed.alerts.count { !it.read }, feed.unread)
        val unread0 = feed.unread!!
        val one = feed.alerts.first { it.type == AlertType.Followup }
        hub.feed.markRead(listOf(one.id)); until("read") { hub.feed.state.value.unread == unread0 - 1 }
        assertTrue(one.id in notifier.cancelled); assertEquals(unread0 - 1, hub.badge.value)
        hub.feed.refresh(); until("refreshed") { !hub.feed.state.value.refreshing && hub.feed.state.value.alerts.first { it.id == one.id }.read }

        // ---- a threshold change: stuck after 2 days. The server now shows this phone the level-2 entries (raised late, so feed only)
        assertTrue(hub.settings.edit(SettingsEdit.TypeValue(AlertType.Stuck, 2))); delay(500)
        control("/__ctl/tick")
        hub.feed.refresh(); until("level 2") { hub.feed.state.value.alerts.any { it.type == AlertType.Stuck && !it.notify && it.wo == 7000002L } }
        assertEquals("the level-3 entry is not shown at level 2", 1, hub.feed.state.value.alerts.count { it.type == AlertType.Stuck && it.wo == 7000002L })
        val cursorBefore = check.cursorValue
        hub.checker.run()
        assertEquals("a late (feed-only) entry does not notify", posted, notifier.posted.size); assertTrue(check.cursorValue!! >= cursorBefore!!)

        // ---- the store reports again: a quiet "back" entry in the feed, never a notification
        control("/__ctl/resume")
        hub.checker.run()
        assertEquals(posted, notifier.posted.size)
        hub.feed.refresh(); until("back") { hub.feed.state.value.alerts.any { it.type == AlertType.Back } }

        // ---- prefs: stores with their last scan, and the oldest app version the server accepts
        val prefs = (client.get("/v1/agents/m/prefs") as ApiResult.Success).value as JsonObject
        val scans = SettingsViewModel.parseScans(prefs)
        assertEquals(setOf(914, 326), scans.keys); assertTrue(scans.values.all { it != null })
        val min = ((prefs["minApp"] as JsonObject)["code"]).toString().toInt()
        assertTrue("the server accepts this app (minApp $min, app ${BuildConfig.VERSION_CODE})", min <= BuildConfig.VERSION_CODE)
        assertEquals("1.0.0", BuildConfig.VERSION_NAME)

        // ---- forget this phone: the server removes it, the phone wipes everything, the old token is dead
        val oldCredentials = store.current.credentials!!
        val resetsBefore = identity.resets
        lock.unlock(); until("unlocked again") { lock.isUnlocked.value }
        auth.signOut()
        assertEquals(AuthState.Unregistered, auth.state.value)
        assertNull(store.current.credentials); assertEquals("", store.current.status); assertNull(store.current.tz)
        assertEquals("device key reset", resetsBefore + 1, identity.resets)
        until("sign-out locks") { !lock.isUnlocked.value }
        val dead = client.call("GET", "/v1/agents/me", credentials = oldCredentials, notify = false) as ApiResult.Failure
        assertEquals(401, dead.status)
        val deadFeed = client.call("GET", "/v1/agents/m/alerts", credentials = oldCredentials, notify = false) as ApiResult.Failure
        assertEquals(401, deadFeed.status)
        control("/__ctl/clock", """{"at":null}""")
    }
}
