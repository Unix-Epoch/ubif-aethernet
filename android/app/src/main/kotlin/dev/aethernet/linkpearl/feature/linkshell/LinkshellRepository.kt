package dev.aethernet.linkpearl.feature.linkshell

import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.data.LinkpearlJson
import dev.aethernet.linkpearl.core.data.P256
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.KeyPair
import java.security.interfaces.ECPublicKey
import java.util.Base64

/** The phone's side of pairing, after the QR code: the browser's name and the check code, waiting for Link on the browser. */
data class Pairing(val code: PairCode, val linkId: String, val store: Int, val pcName: String, val check: String, internal val key: ByteArray) {
    override fun toString() = "Pairing(linkId=$linkId, store=$store, pcName=$pcName)"
}

sealed interface PairResult {
    data class Ok(val pairing: Pairing) : PairResult
    /** expired: the code timed out or was cancelled; noAccess: this phone isn't approved for that store; taken: another phone scanned it. */
    enum class Failed : PairResult { Expired, NoAccess, Taken, Offline, Error }
}

@Serializable
private data class PairAnswer(val linkId: String, val store: Int, val pcName: String = "", val pcJwk: JsonObject)

@Serializable
data class LinkRow(val id: String, val store: Int, val pcName: String = "", val createdAt: String? = null, val usedAt: String? = null)

@Serializable
private data class LinksAnswer(val links: List<LinkRow> = emptyList())

/** The phone routes (tracker-worker/src/linkshell.js: /v1/agents/m/linkshell/…). */
class LinkshellRepository(private val api: ApiClient, private val newKey: () -> KeyPair = LinkshellCrypto::newPairKey) {
    /** Sends this phone's pairing key for a scanned code; the link key is made here and the pairing key dropped. */
    suspend fun pair(code: PairCode): PairResult {
        val kp = newKey()
        val mine = P256.jwk(kp.public as ECPublicKey)
        val body = buildJsonObject { put("pairId", code.pairId); put("code", code.code); put("publicJwk", mine) }
        return when (val r = api.post("$BASE/pair", body)) {
            is ApiResult.Success -> runCatching {
                val a = LinkpearlJson.decodeFromJsonElement(PairAnswer.serializer(), r.value)
                Pairing(code, a.linkId, a.store, a.pcName, LinkshellCrypto.checkCode(a.pcJwk, mine), LinkshellCrypto.linkKey(kp, a.pcJwk, a.linkId))
            }.fold({ PairResult.Ok(it) }, { PairResult.Failed.Error })
            is ApiResult.Failure -> when {
                r.status == 404 -> PairResult.Failed.Expired
                r.status == 403 -> PairResult.Failed.NoAccess
                r.status == 409 -> PairResult.Failed.Taken
                r.error == ApiError.Offline -> PairResult.Failed.Offline
                else -> PairResult.Failed.Error
            }
        }
    }

    /** This phone's links, or null when the server couldn't be asked. */
    suspend fun links(): List<LinkRow>? = when (val r = api.get("$BASE/links")) {
        is ApiResult.Success -> runCatching { LinkpearlJson.decodeFromJsonElement(LinksAnswer.serializer(), r.value).links }.getOrNull()
        is ApiResult.Failure -> null
    }

    /** True once the server has no such link (removed now, or already gone). */
    suspend fun unlink(linkId: String): Boolean = when (val r = api.post("$BASE/unlink", buildJsonObject { put("linkId", linkId) })) {
        is ApiResult.Success -> true
        is ApiResult.Failure -> r.status == 404
    }

    companion object {
        const val BASE = "/v1/agents/m/linkshell"
        fun stored(p: Pairing, at: Long) = StoredLink(p.linkId, p.store, p.pcName, Base64.getEncoder().encodeToString(p.key), at)
    }
}
