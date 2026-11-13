package dev.aethernet.linkpearl.core.lock

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonElement
import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds

/** Customer details re-lock after this much idle time (owner's decision, Nov 13 2026). */
val LOCK_IDLE_TIMEOUT: Duration = 30.minutes

/** Customer details re-lock when the app has been in the background this long. */
val LOCK_BACKGROUND_GRACE: Duration = 60.seconds

/**
 * Whether sealed customer details may be shown. Other features only use [isUnlocked], [unlock] and [lock]; the other members are
 * additive (they have defaults so existing fakes keep compiling) and are used by Work orders.
 *
 * Unlocked = the store private keys this phone holds are in memory (never on disk). [unlock] asks for the phone's biometric or screen
 * lock (system prompt), then unwraps the store keys with the Keystore device key. Re-locks on [lock], after [LOCK_IDLE_TIMEOUT]
 * without [touch], after [LOCK_BACKGROUND_GRACE] in the background, on sign-out / revocation / a change of approved stores, and on
 * process death (nothing is persisted).
 */
interface AppLock {
    val isUnlocked: StateFlow<Boolean>
    fun unlock()
    fun lock()

    /** Time left before the idle re-lock; null while locked. */
    val remaining: StateFlow<Duration?> get() = NO_REMAINING
    /** The current unlock attempt (in progress, or why it failed) for the unlock panel. */
    val attempt: StateFlow<UnlockAttempt> get() = NO_ATTEMPT
    /** Interaction with unlocked content: restarts the idle timer. */
    fun touch() {}
    /** Clears a failed attempt (the panel was closed). */
    fun dismissAttempt() {}
    /** Opens cards and snapshots with the in-memory store keys; null while locked. */
    val opener: SealedOpener? get() = null
}

sealed interface UnlockAttempt {
    data object Idle : UnlockAttempt
    data object InProgress : UnlockAttempt
    data class Failed(val problem: UnlockProblem) : UnlockAttempt
}

enum class UnlockProblem {
    /** No secure lock screen on the phone (the device key was made without user authentication). */
    NoScreenLock,
    /** Too many failed tries; the phone's own timeout applies. */
    Lockout,
    /** Biometrics disabled until the phone is unlocked with its PIN/pattern/password. */
    LockoutPermanent,
    /** The device key is gone (e.g. a new fingerprint was enrolled): the phone must be registered again. */
    KeyInvalidated,
    /** The store keys could not be fetched. */
    Offline,
    /** Anything else (prompt error, the validity window passed, app not set up yet). */
    Failed,
}

/** Opens a sealed card or snapshot for [store]. Throws [NoStoreKeyException] when this phone holds no key for that store. */
interface SealedOpener {
    fun hasKey(store: Int): Boolean
    fun openJson(store: Int, sealed: String, aad: String): JsonElement
}

class NoStoreKeyException(store: Int) : java.security.GeneralSecurityException("no key for store $store")

private val NO_REMAINING: StateFlow<Duration?> = MutableStateFlow<Duration?>(null).asStateFlow()
private val NO_ATTEMPT: StateFlow<UnlockAttempt> = MutableStateFlow<UnlockAttempt>(UnlockAttempt.Idle).asStateFlow()

/** A plain flag with no timeout, no keys and no authentication (previews and other features' tests). */
class StubAppLock : AppLock {
    private val state = MutableStateFlow(false)
    override val isUnlocked: StateFlow<Boolean> = state.asStateFlow()
    override fun unlock() { state.value = true }
    override fun lock() { state.value = false }
}
