package dev.aethernet.linkpearl.core.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.security.SecureRandom

/**
 * Registration with the tracker Worker (MOBILE-API.md "Registration, step by step"), kept in an encrypted [SessionStore].
 *
 * Statuses on disk: "registering" (the request was sent, the answer not seen: retried with the SAME id, token and key so a lost answer
 * cannot strand a pending registration on the server), "pending", "active". The server has no call for a phone to remove itself, so
 * [signOut] only forgets locally (the owner removes the entry on the admin site).
 */
class RealAuth(
    private val store: SessionStore,
    private val transport: AgentTransport,
    private val identity: DeviceIdentity,
    private val resetKey: () -> Unit,
    private val wipeData: () -> Unit = {},
    private val scope: CoroutineScope? = null,
    private val random: SecureRandom = SecureRandom(),
) : Auth, AuthIssues, SessionHooks {
    private val _state = MutableStateFlow(stateOf(store.current))
    override val state: StateFlow<AuthState> get() = _state
    private val _issue = MutableStateFlow<AuthIssue?>(if (store.current.revoked) AuthIssue.Revoked else null)
    override val issue: StateFlow<AuthIssue?> get() = _issue
    private val lock = Mutex()

    override fun dismissIssue() { _issue.value = null }

    override suspend fun register(name: String): Boolean = lock.withLock {
        val cleanName = cleanName(name)
        if (cleanName.isEmpty()) return false
        val have = store.current
        if (have.status == "pending" || have.status == "active") return true

        // Reuse an unfinished attempt (same id, token, key); otherwise start fresh with a new key pair.
        val retry = have.status == "registering" && have.deviceId != null && have.token != null
        val id = if (retry) have.deviceId!! else randomHex(16)
        val token = if (retry) have.token!! else randomHex(32)
        if (!retry) resetKey()
        val jwk = identity.publicJwk()
        store.update { StoredSession(deviceId = id, token = token, name = cleanName, status = "registering") }
        _issue.value = null

        val body = JsonObject(mapOf("id" to JsonPrimitive(id), "name" to JsonPrimitive(cleanName), "kind" to JsonPrimitive("phone"), "publicJwk" to jwk, "token" to JsonPrimitive(token)))
        when (val r = transport.call("POST", "/v1/agents/register", body = body, credentials = null, notify = false)) {
            is ApiResult.Success -> {
                val o = r.value as? JsonObject
                val fingerprint = o?.str("fingerprint")
                if (fingerprint == null) { _issue.value = AuthIssue.Server; return false }
                store.update { it.copy(fingerprint = fingerprint, status = "pending") }
                publish()
                true
            }
            is ApiResult.Failure -> {
                if (r.status == 409) return adoptExisting()
                _issue.value = issueFor(r)
                false
            }
        }
    }

    /** The server already holds this id (our first answer was lost): read it back with our token instead of registering twice. */
    private suspend fun adoptExisting(): Boolean {
        val r = transport.call("GET", "/v1/agents/me", credentials = store.current.credentials, notify = false)
        if (r is ApiResult.Success && applyMe(r.value)) { _issue.value = null; return true }
        store.update { StoredSession() } // not ours: the next attempt starts with a new id
        _issue.value = AuthIssue.Server
        return false
    }

    override suspend fun refresh() {
        lock.withLock {
            val have = store.current
            if (have.status != "pending" && have.status != "active") return
            when (val r = transport.call("GET", "/v1/agents/me", credentials = have.credentials, notify = false)) {
                is ApiResult.Success -> { if (applyMe(r.value)) _issue.value = null else _issue.value = AuthIssue.Server }
                is ApiResult.Failure -> when (r.error) {
                    ApiError.Unauthorized -> forget(revoked = true)
                    else -> _issue.value = issueFor(r)
                }
            }
        }
    }

    override suspend fun signOut() {
        lock.withLock { forget(revoked = false) }
    }

    /** A 401 or "not approved yet" came back on a normal call: re-check in the background. */
    override fun sessionRejected() {
        scope?.launch { refresh() }
    }

    /** Store names come from Home (/me has only ids); remembered so [AuthState.Registered] carries them. */
    fun rememberStoreNames(stores: List<StoreRef>) {
        val names = stores.filter { !it.name.isNullOrBlank() }.associate { it.id to it.name }
        val have = store.current
        if (have.status != "active" || names.isEmpty()) return
        val next = have.stores.map { it.copy(name = names[it.id] ?: it.name) }
        if (next != have.stores) { store.update { it.copy(stores = next) }; publish() }
    }

    private fun forget(revoked: Boolean) {
        resetKey()
        wipeData()
        store.update { StoredSession(revoked = revoked) }
        _issue.value = if (revoked) AuthIssue.Revoked else null
        _state.value = AuthState.Unregistered
    }

    /** Reads a /me answer into the store; false when it is not a phone registration we understand. */
    private fun applyMe(json: JsonElement): Boolean {
        val o = json as? JsonObject ?: return false
        val status = o.str("status") ?: return false
        if (status != "pending" && status != "active") return false
        val ids = (o["stores"] as? JsonArray)?.mapNotNull { runCatching { it.jsonPrimitive.int }.getOrNull() } ?: emptyList()
        val keys = (o["keys"] as? JsonArray)?.mapNotNull { k ->
            val ko = k as? JsonObject ?: return@mapNotNull null
            val st = runCatching { ko["store"]?.jsonPrimitive?.int }.getOrNull() ?: return@mapNotNull null
            val w = ko.str("wrapped") ?: return@mapNotNull null
            st to w
        }?.toMap() ?: emptyMap()
        store.update { s ->
            val known = s.stores.associate { it.id to it.name }
            s.copy(
                status = status, name = o.str("name") ?: s.name, fingerprint = o.str("fingerprint") ?: s.fingerprint,
                stores = ids.map { StoreRef(it, known[it]) }, keys = keys, revoked = false,
            )
        }
        publish()
        return true
    }

    private fun publish() {
        val s = store.current
        _state.value = stateOf(s)
    }

    private fun issueFor(r: ApiResult.Failure): AuthIssue = when (r.error) {
        ApiError.Offline -> AuthIssue.Offline
        ApiError.RateLimited -> if (r.message?.startsWith("too many") == true) AuthIssue.Limit else AuthIssue.Server
        ApiError.Forbidden, ApiError.NotConfigured -> AuthIssue.Refused
        else -> if (r.status == 400) AuthIssue.Refused else AuthIssue.Server
    }

    private fun randomHex(bytes: Int): String = ByteArray(bytes).also(random::nextBytes).joinToString("") { "%02x".format(it) }

    companion object {
        fun stateOf(s: StoredSession): AuthState = when (s.status) {
            "pending" -> AuthState.Pending(s.fingerprint, s.name)
            "active" -> AuthState.Registered(s.name, s.stores)
            else -> AuthState.Unregistered
        }

        /** Control characters out, trimmed, 60 characters at most (the server's own limit). */
        fun cleanName(name: String): String = name.filter { !it.isISOControl() }.trim().take(60).trim()

        private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    }
}

/** [StoreKeys] over the registration kept by [RealAuth]. */
class RealStoreKeys(private val store: SessionStore, private val auth: Auth) : StoreKeys {
    override suspend fun wrapped(refresh: Boolean): Map<Int, String> {
        if (refresh || (store.current.status == "active" && store.current.keys.isEmpty())) auth.refresh()
        return store.current.keys.filterKeys { id -> store.current.stores.any { it.id == id } }
    }
}
