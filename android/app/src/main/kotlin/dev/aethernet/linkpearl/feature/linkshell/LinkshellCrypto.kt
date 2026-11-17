package dev.aethernet.linkpearl.feature.linkshell

import dev.aethernet.linkpearl.core.data.P256
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Linkshell's sealing, the same as Aethernet's (src/67-linkshell.js) so either end opens the other's messages:
 *  - link key: ECDH P-256 between this phone's pairing key and the browser's, then HKDF-SHA256 (salt "linkshell|<linkId>",
 *    info "linkshell v1") to 32 bytes for AES-256-GCM;
 *  - each message: a random 12-byte IV, additional data "<linkId>|<from>|<id>|<kind>" (from = pc or phone), body = JSON text;
 *  - check code: SHA-256 of "<pc x>.<pc y>|<phone x>.<phone y>" (the keys' base64url coordinates), 6 letters from the first 6 bytes.
 * Pure JCA, so the JVM tests check it against the browser's own output (test resources linkshell/interop.json).
 */
object LinkshellCrypto {
    private const val CHECK_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    private val random = SecureRandom()

    /** A pairing key pair, in software: it only lives until the link key is made, then it is dropped. */
    fun newPairKey(): KeyPair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1"), random) }.genKeyPair()

    /** `{kty, crv, x, y}` as a 65-byte uncompressed point. */
    fun uncompressed(jwk: JsonObject): ByteArray {
        fun coord(k: String): ByteArray = Base64.getUrlDecoder().decode((jwk[k] as? JsonPrimitive)?.contentOrNull ?: error("jwk $k missing")).also {
            require(it.size == 32) { "jwk $k must be 32 bytes" }
        }
        return byteArrayOf(4) + coord("x") + coord("y")
    }

    fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int = 32): ByteArray {
        val prk = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(salt, "HmacSHA256")) }.doFinal(ikm)
        val out = ByteArray(length)
        var t = ByteArray(0)
        var done = 0
        var n = 1
        while (done < length) {
            t = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(prk, "HmacSHA256")) }.run { update(t); update(info); update(n.toByte()); doFinal() }
            val take = minOf(t.size, length - done)
            System.arraycopy(t, 0, out, done, take)
            done += take; n++
        }
        return out
    }

    /** The link key from the raw ECDH secret. */
    fun linkKey(shared: ByteArray, linkId: String): ByteArray = hkdf(shared, "linkshell|$linkId".toByteArray(), "linkshell v1".toByteArray())

    /** The link key for this phone: [pair]'s private key with the browser's public key. */
    fun linkKey(pair: KeyPair, pcJwk: JsonObject, linkId: String): ByteArray = linkKey(P256.agree(pair.private, uncompressed(pcJwk)), linkId)

    private fun aad(linkId: String, from: String, id: String, kind: String) = "$linkId|$from|$id|$kind".toByteArray()

    /** (iv, ct), both standard base64, as the browser sends them. */
    fun seal(key: ByteArray, linkId: String, from: String, id: String, kind: String, body: String): Pair<String, String> {
        val iv = ByteArray(12).also(random::nextBytes)
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv)); updateAAD(aad(linkId, from, id, kind))
        }
        val enc = Base64.getEncoder()
        return enc.encodeToString(iv) to enc.encodeToString(c.doFinal(body.toByteArray()))
    }

    /** The body's JSON text; throws when the message was not sealed with this key for this envelope. */
    fun open(key: ByteArray, linkId: String, from: String, id: String, kind: String, iv: String, ct: String): String {
        val dec = Base64.getDecoder()
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, dec.decode(iv))); updateAAD(aad(linkId, from, id, kind))
        }
        return String(c.doFinal(dec.decode(ct)))
    }

    fun checkCode(pcJwk: JsonObject, phoneJwk: JsonObject): String {
        fun s(j: JsonObject, k: String) = (j[k] as? JsonPrimitive)?.contentOrNull.orEmpty()
        val d = MessageDigest.getInstance("SHA-256").digest((s(pcJwk, "x") + "." + s(pcJwk, "y") + "|" + s(phoneJwk, "x") + "." + s(phoneJwk, "y")).toByteArray())
        val code = (0 until 6).map { CHECK_ABC[d[it].toInt() and 31] }.joinToString("")
        return code.take(3) + " " + code.drop(3)
    }

    /** A message id: 16 random bytes, base64url (22 characters). */
    fun newId(): String = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(16).also(random::nextBytes))
}

/** What Aethernet's QR code holds: `LS1.<store>.<pairId>.<code>`. */
data class PairCode(val store: Int, val pairId: String, val code: String) {
    companion object {
        private val RE = Regex("^LS1\\.(\\d{1,9})\\.([0-9a-f]{32})\\.([A-Za-z0-9_-]{22})$")
        fun parse(text: String): PairCode? = RE.matchEntire(text.trim())?.let { m -> PairCode(m.groupValues[1].toInt(), m.groupValues[2], m.groupValues[3]) }
    }
}
