package dev.aethernet.linkpearl.feature.settings

import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.data.Auth
import dev.aethernet.linkpearl.core.data.AuthState
import dev.aethernet.linkpearl.core.data.FakeAuth
import dev.aethernet.linkpearl.core.data.StoreRef
import dev.aethernet.linkpearl.core.lock.StubAppLock
import dev.aethernet.linkpearl.core.prefs.Appearance
import dev.aethernet.linkpearl.core.prefs.MemoryAppPrefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SettingsViewModelTest {
    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    private val registered = AuthState.Registered("Pixel Fold", listOf(StoreRef(914, "Newport News"), StoreRef(326, "Lynnhaven")))

    private class FakeApi(var result: ApiResult<JsonElement>) : ApiClient {
        val paths = mutableListOf<String>()
        override suspend fun get(path: String, query: Map<String, String>): ApiResult<JsonElement> { paths += path; return result }
        override suspend fun post(path: String, body: JsonElement?) = result
        override suspend fun put(path: String, body: JsonElement?) = result
        override suspend fun delete(path: String) = result
    }

    private val prefsJson = Json.parseToJsonElement(
        """{"v":1,"stores":[{"id":914,"name":"Newport News","lastScanAt":"2026-11-13T21:12:00.000Z"},{"id":326,"name":"Lynnhaven","lastScanAt":null}]}""",
    )

    private fun vm(
        auth: Auth = FakeAuth(registered), lock: StubAppLock = StubAppLock(), prefs: MemoryAppPrefs = MemoryAppPrefs(),
        api: ApiClient = FakeApi(ApiResult.Success(prefsJson)),
    ) = SettingsViewModel(auth, lock, prefs, api, tz = "America/New_York")

    @Test fun showsPhoneNameStoresAndTheirLastUpdate() = runTest {
        val s = vm().state.value
        assertEquals("Pixel Fold", s.phoneName)
        assertEquals(listOf(StoreLine(914, "Newport News #914", "4:12 PM"), StoreLine(326, "Lynnhaven #326", "—")), s.stores)
        assertEquals("30 minutes", s.lockAfter)
    }

    @Test fun offlineStillShowsStoreNamesWithoutTimes() = runTest {
        val s = vm(api = FakeApi(ApiResult.Failure(ApiError.Offline))).state.value
        assertEquals(listOf("Newport News #914", "Lynnhaven #326"), s.stores.map { it.label })
        assertTrue(s.stores.all { it.updated == null })
    }

    @Test fun lockStateAndToggle() = runTest {
        val lock = StubAppLock()
        val vm = vm(lock = lock)
        assertFalse(vm.state.value.unlocked)
        vm.toggleLock()
        assertTrue(lock.isUnlocked.value); assertTrue(vm.state.value.unlocked)
        vm.toggleLock()
        assertFalse(lock.isUnlocked.value); assertFalse(vm.state.value.unlocked)
    }

    @Test fun notificationStateFollowsTheSystemCheck() = runTest {
        val vm = vm()
        assertFalse(vm.state.value.notificationsOn)
        vm.onNotificationsChecked(true); assertTrue(vm.state.value.notificationsOn)
        vm.onNotificationsChecked(false); assertFalse(vm.state.value.notificationsOn)
    }

    @Test fun permissionIsRequestedOnceThenSettingsOpen() = runTest {
        val prefs = MemoryAppPrefs()
        val vm = vm(prefs = prefs)
        assertEquals(NotificationAction.RequestPermission, vm.onNotificationsTapped(34, vm.notificationsAsked()))
        assertTrue(prefs.notificationsAsked.first())
        assertEquals(NotificationAction.OpenSettings, vm.onNotificationsTapped(34, vm.notificationsAsked()))
    }

    @Test fun belowAndroid13OnlySettingsCanHelp() {
        assertEquals(NotificationAction.OpenSettings, notificationAction(32, alreadyAsked = false))
        assertEquals(NotificationAction.RequestPermission, notificationAction(33, alreadyAsked = false))
        assertEquals(NotificationAction.OpenSettings, notificationAction(33, alreadyAsked = true))
    }

    @Test fun appearanceIsAppliedAndRemembered() = runTest {
        val prefs = MemoryAppPrefs()
        val vm = vm(prefs = prefs)
        assertEquals(Appearance.Dark, vm.state.value.appearance)
        vm.setAppearance(Appearance.Light)
        assertEquals(Appearance.Light, vm.state.value.appearance)
        assertEquals(Appearance.Light, prefs.appearance.first())
        vm.setAppearance(Appearance.System)
        assertEquals(Appearance.System, prefs.appearance.first())
    }

    @Test fun forgetNeedsConfirmationAndCancelDoesNothing() = runTest {
        val auth = FakeAuth(registered)
        val vm = vm(auth = auth)
        vm.askForget(); assertTrue(vm.state.value.confirmForget)
        vm.cancelForget(); assertFalse(vm.state.value.confirmForget)
        assertEquals(registered, auth.state.value)
    }

    @Test fun confirmingSignsOutAndTheAppReturnsToOnboarding() = runTest {
        val auth = FakeAuth(registered)
        val vm = vm(auth = auth)
        vm.askForget(); vm.confirmForget()
        assertEquals(AuthState.Unregistered, auth.state.value)
        assertFalse(vm.state.value.confirmForget); assertFalse(vm.state.value.forgetting)
        assertNull(vm.state.value.phoneName)
    }

    @Test fun signOutIsCalledOnceEvenIfTappedTwice() = runTest {
        var calls = 0
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        val auth = object : Auth {
            override val state = kotlinx.coroutines.flow.MutableStateFlow<AuthState>(registered)
            override suspend fun register(name: String) = true
            override suspend fun refresh() {}
            override suspend fun signOut() { calls++; gate.await() }
        }
        val vm = vm(auth = auth)
        vm.confirmForget(); vm.confirmForget()
        assertTrue(vm.state.value.forgetting)
        gate.complete(Unit)
        assertEquals(1, calls)
    }

    @Test fun lockLabelIsTheFixedTimeout() { assertEquals("30 minutes", lockAfterLabel()) }
}
