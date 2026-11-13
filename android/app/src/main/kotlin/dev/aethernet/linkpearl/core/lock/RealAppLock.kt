package dev.aethernet.linkpearl.core.lock

import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.UserNotAuthenticatedException
import dev.aethernet.linkpearl.core.data.Auth
import dev.aethernet.linkpearl.core.data.AuthState
import dev.aethernet.linkpearl.core.data.DeviceIdentity
import dev.aethernet.linkpearl.core.data.StoreKeys
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds

/** Asks the person for the phone's biometric or screen lock. */
fun interface UnlockPrompt {
    suspend fun authenticate(): PromptResult
}

enum class PromptResult { Success, Cancelled, Lockout, LockoutPermanent, NoCredential, Error }

/**
 * The real [AppLock]: a small state machine around the in-memory [Keyring].
 *
 * Unlock: (1) refuse when the phone has no secure lock screen ([DeviceIdentity.requiresUserAuth] false); (2) fetch the wrapped store
 * keys first (network, so it cannot eat into the authentication window); (3) system prompt; (4) right away, unwrap each store key with
 * the Keystore device key ([DeviceIdentity.agree], valid for AUTH_VALIDITY_SECONDS after the prompt) and keep the PKCS#8 bytes in the
 * keyring. A store without a wrapped key simply has no key ("No key for this store" on its details).
 *
 * Re-lock: [lock]; idle for [idleTimeout] (the ticker compares against [clock], restarted by [touch]); in the background for
 * [backgroundGrace] ([onBackground]/[onForeground], fed by [ActivityTracker]); [Auth.state] leaving Registered or its store list
 * changing. [clock] is a monotonic millisecond clock (elapsedRealtime in the app, virtual time in tests).
 */
class RealAppLock(
    private val scope: CoroutineScope,
    private val storeKeys: () -> StoreKeys,
    private val identity: () -> DeviceIdentity,
    private val auth: () -> Auth,
    private val prompt: UnlockPrompt,
    private val clock: () -> Long,
    private val work: CoroutineDispatcher = Dispatchers.Default,
    private val idleTimeout: Duration = LOCK_IDLE_TIMEOUT,
    private val backgroundGrace: Duration = LOCK_BACKGROUND_GRACE,
) : AppLock {
    private val keyring = Keyring()
    private val _unlocked = MutableStateFlow(false)
    private val _remaining = MutableStateFlow<Duration?>(null)
    private val _attempt = MutableStateFlow<UnlockAttempt>(UnlockAttempt.Idle)

    override val isUnlocked: StateFlow<Boolean> = _unlocked.asStateFlow()
    override val remaining: StateFlow<Duration?> = _remaining.asStateFlow()
    override val attempt: StateFlow<UnlockAttempt> = _attempt.asStateFlow()
    override val opener: SealedOpener? get() = if (_unlocked.value) keyring else null

    @Volatile private var deadline = 0L
    private var unlockJob: Job? = null
    private var tickJob: Job? = null
    private var backgroundJob: Job? = null
    @Volatile private var backgroundAt: Long? = null
    private var lastStores: Set<Int>? = null

    init {
        scope.launch {
            val a = runCatching { auth() }.getOrNull() ?: return@launch
            a.state.collect { onAuth(it) }
        }
    }

    private fun onAuth(s: AuthState) {
        if (s !is AuthState.Registered) {
            lastStores = null
            lock()
            return
        }
        val ids = s.stores.map { it.id }.toSet()
        if (lastStores != null && lastStores != ids) lock()
        lastStores = ids
    }

    override fun unlock() {
        if (_unlocked.value) { touch(); return }
        if (unlockJob?.isActive == true) return
        _attempt.value = UnlockAttempt.InProgress
        unlockJob = scope.launch {
            val outcome = try { attemptUnlock() } catch (e: CancellationException) { throw e } catch (_: Exception) { Outcome.Fail(UnlockProblem.Failed) }
            _attempt.value = if (outcome is Outcome.Fail) UnlockAttempt.Failed(outcome.problem) else UnlockAttempt.Idle
        }
    }

    private sealed interface Outcome {
        data object Unlocked : Outcome
        data object Cancelled : Outcome
        data class Fail(val problem: UnlockProblem) : Outcome
    }

    private suspend fun attemptUnlock(): Outcome {
        val id = runCatching { identity() }.getOrNull() ?: return Outcome.Fail(UnlockProblem.Failed)
        if (!id.requiresUserAuth) return Outcome.Fail(UnlockProblem.NoScreenLock)
        val deviceId = id.deviceId ?: return Outcome.Fail(UnlockProblem.Failed)
        val keys = runCatching { storeKeys() }.getOrNull() ?: return Outcome.Fail(UnlockProblem.Failed)
        val wrapped = try {
            keys.wrapped().ifEmpty { keys.wrapped(refresh = true) }
        } catch (e: CancellationException) { throw e } catch (_: Exception) { return Outcome.Fail(UnlockProblem.Offline) }

        when (prompt.authenticate()) {
            PromptResult.Success -> Unit
            PromptResult.Cancelled -> return Outcome.Cancelled
            PromptResult.Lockout -> return Outcome.Fail(UnlockProblem.Lockout)
            PromptResult.LockoutPermanent -> return Outcome.Fail(UnlockProblem.LockoutPermanent)
            PromptResult.NoCredential -> return Outcome.Fail(UnlockProblem.NoScreenLock)
            PromptResult.Error -> return Outcome.Fail(UnlockProblem.Failed)
        }

        val problem = withContext(work) { unwrapAll(id, deviceId, wrapped) }
        if (problem != null) { keyring.clear(); return Outcome.Fail(problem) }
        deadline = clock() + idleTimeout.inWholeMilliseconds
        _remaining.value = idleTimeout
        _unlocked.value = true
        startTicker()
        return Outcome.Unlocked
    }

    private fun unwrapAll(id: DeviceIdentity, deviceId: String, wrapped: Map<Int, String>): UnlockProblem? {
        keyring.clear()
        for ((store, sealed) in wrapped) {
            try {
                val pkcs8 = SealedBox.open(sealed, SealedBox.Aad.agentKey(deviceId, store)) { epk -> id.agree(epk) }
                keyring.put(store, pkcs8)
            } catch (e: Exception) {
                when (classify(e)) {
                    KeyFailure.Invalidated -> return UnlockProblem.KeyInvalidated
                    KeyFailure.NotAuthenticated -> return UnlockProblem.Failed
                    KeyFailure.Other -> Unit // this store's copy does not open: treated as "no key for this store"
                }
            }
        }
        return null
    }

    private enum class KeyFailure { Invalidated, NotAuthenticated, Other }

    private fun classify(e: Throwable): KeyFailure {
        var t: Throwable? = e
        while (t != null) {
            if (t is KeyPermanentlyInvalidatedException) return KeyFailure.Invalidated
            if (t is UserNotAuthenticatedException) return KeyFailure.NotAuthenticated
            t = t.cause
        }
        return KeyFailure.Other
    }

    private fun startTicker() {
        tickJob?.cancel()
        tickJob = scope.launch {
            while (_unlocked.value) {
                val left = deadline - clock()
                if (left <= 0) { lock(); break }
                _remaining.value = left.milliseconds
                delay(minOf(left, 1000L))
            }
        }
    }

    override fun touch() {
        if (!_unlocked.value) return
        deadline = clock() + idleTimeout.inWholeMilliseconds
        _remaining.value = idleTimeout
    }

    override fun lock() {
        unlockJob?.cancel(); unlockJob = null
        tickJob?.cancel(); tickJob = null
        backgroundJob?.cancel(); backgroundJob = null
        keyring.clear()
        _unlocked.value = false
        _remaining.value = null
        if (_attempt.value == UnlockAttempt.InProgress) _attempt.value = UnlockAttempt.Idle
    }

    override fun dismissAttempt() {
        if (_attempt.value is UnlockAttempt.Failed) _attempt.value = UnlockAttempt.Idle
    }

    /** The app went to the background (no started activity). */
    fun onBackground() {
        backgroundAt = clock()
        if (!_unlocked.value) return
        backgroundJob?.cancel()
        backgroundJob = scope.launch { delay(backgroundGrace); lock() }
    }

    /** The app came back. Also checks the elapsed time, in case the delayed lock did not run while the phone slept. */
    fun onForeground() {
        backgroundJob?.cancel(); backgroundJob = null
        val since = backgroundAt
        backgroundAt = null
        if (_unlocked.value && since != null && clock() - since >= backgroundGrace.inWholeMilliseconds) lock()
    }
}
