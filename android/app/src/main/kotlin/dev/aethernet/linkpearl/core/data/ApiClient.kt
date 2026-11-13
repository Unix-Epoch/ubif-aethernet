package dev.aethernet.linkpearl.core.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/*
 * Agent B's worktree copy of agent A's interfaces (core/data). Only the declarations agreed for the parallel build, plus trivial
 * unconfigured stubs so the app still compiles and runs here. Agent A's real file replaces this one at merge.
 */

interface ApiClient {
    suspend fun get(path: String, query: Map<String, String> = emptyMap()): ApiResult<JsonElement>
    suspend fun post(path: String, body: JsonElement? = null): ApiResult<JsonElement>
    suspend fun put(path: String, body: JsonElement? = null): ApiResult<JsonElement>
    suspend fun delete(path: String): ApiResult<JsonElement>
}

sealed interface ApiResult<out T> {
    data class Success<T>(val value: T) : ApiResult<T>
    data class Failure(val error: ApiError, val status: Int? = null, val message: String? = null) : ApiResult<Nothing>
}

enum class ApiError { NotConfigured, Offline, Unauthorized, Forbidden, NotFound, RateLimited, Server }

interface DeviceIdentity {
    val deviceId: String?
    fun publicJwk(): JsonObject
    /** Raw 32-byte ECDH shared secret with [peerPublic] (65-byte uncompressed P-256 point); needs recent user authentication. */
    fun agree(peerPublic: ByteArray): ByteArray
    val requiresUserAuth: Boolean
}

const val AUTH_VALIDITY_SECONDS = 30

interface StoreKeys {
    /** store id -> this phone's wrapped copy of that store's private key ("v1.…", aad "agentkey|<deviceId>|<store>"). */
    suspend fun wrapped(refresh: Boolean = false): Map<Int, String>
}

interface Auth {
    val state: StateFlow<AuthState>
    suspend fun register(name: String): Boolean
    suspend fun refresh()
    suspend fun signOut()
}

sealed interface AuthState {
    data object Unregistered : AuthState
    data class Pending(val fingerprint: String, val name: String) : AuthState
    data class Registered(val name: String, val stores: List<StoreRef>) : AuthState
}

/** Answers every call with [ApiError.NotConfigured] until agent A provides the real client. */
object UnconfiguredApiClient : ApiClient {
    override suspend fun get(path: String, query: Map<String, String>) = ApiResult.Failure(ApiError.NotConfigured)
    override suspend fun post(path: String, body: JsonElement?) = ApiResult.Failure(ApiError.NotConfigured)
    override suspend fun put(path: String, body: JsonElement?) = ApiResult.Failure(ApiError.NotConfigured)
    override suspend fun delete(path: String) = ApiResult.Failure(ApiError.NotConfigured)
}

/** Placeholder: reports Registered so the app is reachable until onboarding exists. */
class FakeAuth(initial: AuthState = AuthState.Registered("Phone", emptyList())) : Auth {
    override val state = MutableStateFlow(initial)
    override suspend fun register(name: String): Boolean { state.value = AuthState.Registered(name, emptyList()); return true }
    override suspend fun refresh() {}
    override suspend fun signOut() { state.value = AuthState.Unregistered }
}
