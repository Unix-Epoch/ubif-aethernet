package dev.aethernet.linkpearl.core.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * The only thing that talks to the Aethernet servers (the tracker Worker, `tracker-worker/MOBILE-API.md`). Real implementation:
 * [OkHttpApiClient]. No exceptions cross this boundary: every outcome is an [ApiResult].
 *
 * Requests carry the public app key and, once this phone is registered, `Authorization: Bearer <id>.<token>`. A 401, or a 403 "not approved
 * yet", also tells [Auth] to re-check the registration. Feature code defines its own `@Serializable` models and decodes with [LinkpearlJson].
 */
interface ApiClient {
    suspend fun get(path: String, query: Map<String, String> = emptyMap()): ApiResult<JsonElement>
    suspend fun post(path: String, body: JsonElement? = null): ApiResult<JsonElement>
    suspend fun put(path: String, body: JsonElement? = null): ApiResult<JsonElement>
    suspend fun delete(path: String): ApiResult<JsonElement>
}

sealed interface ApiResult<out T> {
    data class Success<T>(val value: T) : ApiResult<T>
    /** [status] is the HTTP status when the server answered; [message] is the server's `{"error": ...}` text (never contains secrets). */
    data class Failure(val error: ApiError, val status: Int? = null, val message: String? = null) : ApiResult<Nothing>
}

enum class ApiError { NotConfigured, Offline, Unauthorized, Forbidden, NotFound, RateLimited, Server }

/** Answers every call with [ApiError.NotConfigured]. */
object UnconfiguredApiClient : ApiClient {
    override suspend fun get(path: String, query: Map<String, String>) = ApiResult.Failure(ApiError.NotConfigured)
    override suspend fun post(path: String, body: JsonElement?) = ApiResult.Failure(ApiError.NotConfigured)
    override suspend fun put(path: String, body: JsonElement?) = ApiResult.Failure(ApiError.NotConfigured)
    override suspend fun delete(path: String) = ApiResult.Failure(ApiError.NotConfigured)
}

/**
 * Whether this phone is registered with the server and approved. The app shows `feature/onboarding` unless [state] is
 * [AuthState.Registered] with at least one store. Real implementation: [RealAuth].
 */
interface Auth {
    val state: StateFlow<AuthState>
    /** Registers this phone under [name]; state becomes Pending until the owner approves it on the admin site. */
    suspend fun register(name: String): Boolean
    /** Re-reads GET /v1/agents/me; Pending -> Registered once approved; Registered -> Unregistered if revoked. */
    suspend fun refresh()
    /** Forgets this phone: tells the server if it can, then deletes the token, the stored state and the device key. */
    suspend fun signOut()
}

sealed interface AuthState {
    data object Unregistered : AuthState
    data class Pending(val fingerprint: String, val name: String) : AuthState
    data class Registered(val name: String, val stores: List<StoreRef>) : AuthState
}

/** Why onboarding shows a line. Extra to [Auth] so its shape stays as agreed; implemented by [RealAuth] and [FakeAuth]. */
enum class AuthIssue { Offline, Server, Limit, Refused, Revoked }

interface AuthIssues {
    val issue: StateFlow<AuthIssue?>
    fun dismissIssue()
}

/** Test and screenshot double: reports whatever it is given. [register] moves to Pending. */
class FakeAuth(initial: AuthState = AuthState.Registered("Test phone", listOf(StoreRef(999999, "Sandbox Store"), StoreRef(326, "Lynnhaven")))) : Auth, AuthIssues {
    override val state = MutableStateFlow(initial)
    override val issue = MutableStateFlow<AuthIssue?>(null)
    override suspend fun register(name: String): Boolean { state.value = AuthState.Pending("3F2A-91C0-7B44-0DDE", name); return true }
    override suspend fun refresh() {}
    override suspend fun signOut() { state.value = AuthState.Unregistered }
    override fun dismissIssue() { issue.value = null }
}

/** Store id -> this phone's wrapped copy of that store's private key (see [DeviceIdentity]). */
interface StoreKeys {
    /** The sealed "v1.…" strings from GET /v1/agents/me, additional data `agentkey|<deviceId>|<store>`. Empty until approved with keys. */
    suspend fun wrapped(refresh: Boolean = false): Map<Int, String>
}

/** Convenience for tests of other features. */
class FakeStoreKeys(private val keys: Map<Int, String> = emptyMap()) : StoreKeys {
    override suspend fun wrapped(refresh: Boolean): Map<Int, String> = keys
}

internal val EmptyObject = JsonObject(emptyMap())
