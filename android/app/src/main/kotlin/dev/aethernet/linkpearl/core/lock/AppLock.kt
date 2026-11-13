package dev.aethernet.linkpearl.core.lock

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes

/** Customer details re-lock after this much idle time (owner's decision, Nov 13 2026). */
val LOCK_IDLE_TIMEOUT: Duration = 30.minutes

/**
 * Interface only (agent B implements it in `core/lock`, with the passphrase/biometric unlock UI in `feature/workorders`).
 *
 * "Unlocked" means sealed customer details may be shown. The implementation re-locks after [LOCK_IDLE_TIMEOUT] without use and
 * whenever [lock] is called (the lock button). [isUnlocked] drives the Locked / "Locks in 28:14" chip.
 */
interface AppLock {
    val isUnlocked: StateFlow<Boolean>
    fun unlock()
    fun lock()
}

/** Placeholder until agent B's implementation: a plain flag with no timeout and no authentication. */
class StubAppLock : AppLock {
    private val state = MutableStateFlow(false)
    override val isUnlocked: StateFlow<Boolean> = state.asStateFlow()
    override fun unlock() { state.value = true }
    override fun lock() { state.value = false }
}
