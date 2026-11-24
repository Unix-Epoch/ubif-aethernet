package dev.aethernet.linkpearl.core.data

import kotlinx.coroutines.flow.MutableStateFlow

/** Test and screenshot double: reports whatever it is given. [register] moves to Pending. */
class FakeAuth(initial: AuthState = AuthState.Registered("Test phone", listOf(StoreRef(999999, "Sandbox Store"), StoreRef(326, "Lynnhaven")))) : Auth, AuthIssues {
    override val state = MutableStateFlow(initial)
    override val issue = MutableStateFlow<AuthIssue?>(null)
    override suspend fun register(name: String): Boolean { state.value = AuthState.Pending("3F2A-91C0-7B44-0DDE", name); return true }
    override suspend fun refresh() {}
    override suspend fun signOut() { state.value = AuthState.Unregistered }
    override fun dismissIssue() { issue.value = null }
}

/** Convenience for tests of other features. */
class FakeStoreKeys(private val keys: Map<Int, String> = emptyMap()) : StoreKeys {
    override suspend fun wrapped(refresh: Boolean): Map<Int, String> = keys
}
