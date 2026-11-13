package dev.aethernet.linkpearl.core.lock

import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.UserNotAuthenticatedException
import dev.aethernet.linkpearl.core.data.Auth
import dev.aethernet.linkpearl.core.data.AuthState
import dev.aethernet.linkpearl.core.data.DeviceIdentity
import dev.aethernet.linkpearl.core.data.StoreKeys
import dev.aethernet.linkpearl.core.data.StoreRef
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.security.interfaces.ECPublicKey
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds

/** A software stand-in for the Keystore device key. */
class FakeDeviceIdentity(var requiresAuth: Boolean = true) : DeviceIdentity {
    val pair = TestCrypto.newKeyPair()
    var failWith: (() -> Exception)? = null
    var agreeCalls = 0
    override val deviceId: String = "a1".repeat(16)
    override fun publicJwk(): JsonObject = JsonObject(emptyMap())
    override fun agree(peerPublic: ByteArray): ByteArray {
        agreeCalls++
        failWith?.let { throw it() }
        return SealedBox.softwareAgree(pair.private, peerPublic)
    }
    override val requiresUserAuth: Boolean get() = requiresAuth
    fun wrap(store: Int, pkcs8: ByteArray = TestCrypto.vectorPkcs8()) = TestCrypto.seal(pkcs8, pair.public as ECPublicKey, SealedBox.Aad.agentKey(deviceId, store))
}

class FakeStoreKeys(var map: Map<Int, String>, var refreshed: Map<Int, String>? = null) : StoreKeys {
    var refreshCalls = 0
    override suspend fun wrapped(refresh: Boolean): Map<Int, String> {
        if (refresh) { refreshCalls++; return refreshed ?: map }
        return map
    }
}

class TestAuth(initial: AuthState = AuthState.Registered("Fold", listOf(StoreRef(914, "Sandbox"), StoreRef(326, "Lynnhaven")))) : Auth {
    override val state = MutableStateFlow(initial)
    override suspend fun register(name: String) = true
    override suspend fun refresh() {}
    override suspend fun signOut() { state.value = AuthState.Unregistered }
}

class FakePrompt(var result: PromptResult = PromptResult.Success) : UnlockPrompt {
    var calls = 0
    override suspend fun authenticate(): PromptResult { calls++; return result }
}

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class RealAppLockTest {
    private val device = FakeDeviceIdentity()
    private val other = FakeDeviceIdentity()
    private val keys = FakeStoreKeys(mapOf(914 to device.wrap(914), 326 to other.wrap(326)))
    private val auth = TestAuth()
    private val prompt = FakePrompt()

    private fun TestScope.newLock(): RealAppLock = RealAppLock(
        scope = backgroundScope, storeKeys = { keys }, identity = { device }, auth = { auth }, prompt = prompt,
        clock = { testScheduler.currentTime }, work = StandardTestDispatcher(testScheduler),
    ).also { runCurrent() }

    private fun TestScope.unlocked(): RealAppLock = newLock().also { it.unlock(); runCurrent() }

    @Test fun unlockKeepsTheKeysThisPhoneCanOpen() = runTest {
        val lock = unlocked()
        assertTrue(lock.isUnlocked.value)
        assertEquals(1, prompt.calls)
        assertEquals(UnlockAttempt.Idle, lock.attempt.value)
        assertEquals(30.minutes, lock.remaining.value)
        val opener = lock.opener!!
        assertTrue(opener.hasKey(914))
        assertFalse("wrapped to another device: no key", opener.hasKey(326))
        assertEquals("Sam Sample", opener.openJson(914, TestCrypto.VECTOR_CARD, "card|914|700000123").jsonObject["name"]!!.jsonPrimitive.content)
    }

    @Test fun idleTimeoutLocksAndTouchRestartsIt() = runTest {
        val lock = unlocked()
        advanceTimeBy(29.minutes); runCurrent()
        assertTrue(lock.isUnlocked.value)
        assertEquals(1.minutes, lock.remaining.value)
        lock.touch()
        assertEquals(30.minutes, lock.remaining.value)
        advanceTimeBy(29.minutes); runCurrent()
        assertTrue(lock.isUnlocked.value)
        advanceTimeBy(61.seconds); runCurrent()
        assertFalse(lock.isUnlocked.value)
        assertNull(lock.opener)
        assertNull(lock.remaining.value)
    }

    @Test fun countdownTicksEverySecond() = runTest {
        val lock = unlocked()
        advanceTimeBy(1_000 + 1); runCurrent()
        assertEquals(30.minutes - 1.seconds, lock.remaining.value)
        advanceTimeBy(105_000); runCurrent()
        assertEquals(28.minutes + 14.seconds, lock.remaining.value)
    }

    @Test fun backgroundGraceOfSixtySeconds() = runTest {
        val lock = unlocked()
        lock.onBackground()
        advanceTimeBy(59.seconds); runCurrent()
        lock.onForeground()
        advanceTimeBy(5.minutes); runCurrent()
        assertTrue("back within the grace: still unlocked", lock.isUnlocked.value)
        lock.onBackground()
        advanceTimeBy(61.seconds); runCurrent()
        assertFalse(lock.isUnlocked.value)
    }

    @Test fun foregroundAfterTheGraceLocksEvenIfTheTimerDidNotRun() = runTest {
        var now = 0L
        val lock = RealAppLock(backgroundScope, { keys }, { device }, { auth }, prompt, clock = { now }, work = StandardTestDispatcher(testScheduler))
        runCurrent(); lock.unlock(); runCurrent()
        assertTrue(lock.isUnlocked.value)
        lock.onBackground()
        now += 120_000 // the phone slept: the delayed lock never ran
        lock.onForeground()
        assertFalse(lock.isUnlocked.value)
    }

    @Test fun signOutAndRevocationLock() = runTest {
        val lock = unlocked()
        auth.state.value = AuthState.Unregistered; runCurrent()
        assertFalse(lock.isUnlocked.value)
    }

    @Test fun aChangeOfApprovedStoresLocks() = runTest {
        val lock = unlocked()
        auth.state.value = AuthState.Registered("Fold", listOf(StoreRef(914, "Sandbox"), StoreRef(326, "Lynnhaven"))); runCurrent()
        assertTrue("same stores: stays unlocked", lock.isUnlocked.value)
        auth.state.value = AuthState.Registered("Fold", listOf(StoreRef(914, "Sandbox"))); runCurrent()
        assertFalse(lock.isUnlocked.value)
    }

    @Test fun lockNowClearsEverything() = runTest {
        val lock = unlocked()
        val opener = lock.opener!!
        lock.lock()
        assertFalse(lock.isUnlocked.value)
        assertNull(lock.opener)
        assertFalse("keyring emptied", opener.hasKey(914))
    }

    @Test fun noScreenLockRefusesWithoutPrompting() = runTest {
        device.requiresAuth = false
        val lock = unlocked()
        assertFalse(lock.isUnlocked.value)
        assertEquals(UnlockAttempt.Failed(UnlockProblem.NoScreenLock), lock.attempt.value)
        assertEquals(0, prompt.calls)
        lock.dismissAttempt()
        assertEquals(UnlockAttempt.Idle, lock.attempt.value)
    }

    @Test fun cancelIsQuietAndLockoutIsReported() = runTest {
        prompt.result = PromptResult.Cancelled
        val lock = unlocked()
        assertFalse(lock.isUnlocked.value)
        assertEquals(UnlockAttempt.Idle, lock.attempt.value)
        prompt.result = PromptResult.Lockout
        lock.unlock(); runCurrent()
        assertEquals(UnlockAttempt.Failed(UnlockProblem.Lockout), lock.attempt.value)
        prompt.result = PromptResult.LockoutPermanent
        lock.unlock(); runCurrent()
        assertEquals(UnlockAttempt.Failed(UnlockProblem.LockoutPermanent), lock.attempt.value)
        assertEquals(0, device.agreeCalls)
    }

    @Test fun invalidatedDeviceKeyAsksToRegisterAgain() = runTest {
        device.failWith = { KeyPermanentlyInvalidatedException() }
        val lock = unlocked()
        assertFalse(lock.isUnlocked.value)
        assertEquals(UnlockAttempt.Failed(UnlockProblem.KeyInvalidated), lock.attempt.value)
    }

    @Test fun authenticationWindowPassedFailsCleanly() = runTest {
        device.failWith = { UserNotAuthenticatedException() }
        val lock = unlocked()
        assertFalse(lock.isUnlocked.value)
        assertEquals(UnlockAttempt.Failed(UnlockProblem.Failed), lock.attempt.value)
    }

    @Test fun noKeysDeliveredYetStillUnlocksWithoutKeys() = runTest {
        keys.map = emptyMap()
        val lock = unlocked()
        assertEquals(1, keys.refreshCalls)
        assertTrue(lock.isUnlocked.value)
        assertFalse(lock.opener!!.hasKey(914))
    }

    @Test fun keysThatCannotBeFetchedReportOffline() = runTest {
        val failing = object : StoreKeys { override suspend fun wrapped(refresh: Boolean): Map<Int, String> = throw java.io.IOException("offline") }
        val lock = RealAppLock(backgroundScope, { failing }, { device }, { auth }, prompt, { testScheduler.currentTime }, StandardTestDispatcher(testScheduler))
        runCurrent(); lock.unlock(); runCurrent()
        assertEquals(UnlockAttempt.Failed(UnlockProblem.Offline), lock.attempt.value)
        assertEquals(0, prompt.calls)
    }
}
