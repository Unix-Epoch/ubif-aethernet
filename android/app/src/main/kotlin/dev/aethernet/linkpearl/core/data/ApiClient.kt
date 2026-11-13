package dev.aethernet.linkpearl.core.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonElement

/**
 * STUB for agent A (`core/data` API client and auth implementation).
 *
 * ApiClient is the only thing that talks to the Aethernet servers. Intended responsibilities of the real implementation:
 *  - base URL of the admin/tracker Workers (build config or [Auth]-provided), HTTPS only, OkHttp 5 underneath;
 *  - authenticates every request with the device identity from [DeviceIdentity] (hardware-backed key, request signing), never a
 *    browser cookie and never the userscript's app key;
 *  - maps transport and HTTP outcomes to [ApiResult] (no exceptions across this boundary): no network -> [ApiError.Offline],
 *    401/403 -> [ApiError.Unauthorized] (also tells [Auth] the device is no longer accepted), 5xx/bad JSON -> [ApiError.Server];
 *  - decodes with [LinkpearlJson]; features define their own `@Serializable` models in their own package and call [get]/[post].
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

/** Answers every call with [ApiError.NotConfigured] until agent A provides the real client. */
object UnconfiguredApiClient : ApiClient {
    override suspend fun get(path: String, query: Map<String, String>) = ApiResult.Failure(ApiError.NotConfigured)
    override suspend fun post(path: String, body: JsonElement?) = ApiResult.Failure(ApiError.NotConfigured)
    override suspend fun put(path: String, body: JsonElement?) = ApiResult.Failure(ApiError.NotConfigured)
    override suspend fun delete(path: String) = ApiResult.Failure(ApiError.NotConfigured)
}

/**
 * STUB for agent A (`feature/onboarding` + `core/data`).
 *
 * Whether this phone is registered with the server and may call it. The app shows `feature/onboarding` while [state] is
 * [AuthState.Unregistered] and the normal navigation once it is [AuthState.Registered]. Real implementation: register the device
 * (send the public key from [DeviceIdentity] with a one-time code from the admin site), store the result, handle revocation.
 */
interface Auth {
    val state: StateFlow<AuthState>
    suspend fun register(name: String): Boolean
    suspend fun refresh()
    /** Forgets this phone: tells the server if it can, then deletes the token, stored state and device key. */
    suspend fun signOut()
}

sealed interface AuthState {
    data object Unregistered : AuthState
    data class Pending(val fingerprint: String, val name: String) : AuthState
    data class Registered(val name: String, val stores: List<StoreRef>) : AuthState
}

/** Placeholder: reports Registered so the fake Home is reachable until onboarding exists. */
class FakeAuth(initial: AuthState = AuthState.Registered("This phone", emptyList())) : Auth {
    override val state = MutableStateFlow(initial)
    override suspend fun register(name: String): Boolean { state.value = AuthState.Registered(name, emptyList()); return true }
    override suspend fun refresh() {}
    override suspend fun signOut() { state.value = AuthState.Unregistered }
}

/**
 * STUB for agent A. This phone's cryptographic identity: an EC key pair created in the Android Keystore (hardware-backed, never
 * exportable; this is why minSdk is 31), used for ECDH key agreement with the server and for signing requests.
 */
interface DeviceIdentity {
    /** Stable id for this install (derived from the public key). Null until created. */
    val deviceId: String?
    /** X.509 public key, Base64, for registration. Creates the key pair on first call. */
    fun publicKey(): String
    /** Signs [payload] with the device key (ECDSA). */
    fun sign(payload: ByteArray): ByteArray
    /** ECDH with the server's public key; the raw shared secret stays inside the Keystore operation where the platform allows. */
    fun agree(serverPublicKey: ByteArray): ByteArray
}
