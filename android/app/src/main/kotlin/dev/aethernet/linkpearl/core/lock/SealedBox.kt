package dev.aethernet.linkpearl.core.lock

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.GeneralSecurityException
import java.security.KeyFactory
import java.security.PrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import java.util.zip.GZIPInputStream
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The tracker's sealed-data format v1 (tracker-worker/src/crypto.js), opened on the phone. Pure JCA, no Android types, so it runs
 * in JVM unit tests against the server's test vector.
 *
 *     "v1." + base64url( epk(65, uncompressed P-256 point) | iv(12) | AES-256-GCM ciphertext with the 16-byte tag last )
 *     shared = ECDH(recipient private key, epk)          (32-byte x coordinate)
 *     key    = HKDF-SHA256(ikm = shared, salt = epk, info = "aethernet-tracker v1", 32 bytes)
 *     plain  = AES-256-GCM-decrypt(key, iv, ct, aad = ASCII item binding)
 *
 * Every intermediate secret (shared secret, AES key bytes, decompressed buffers the caller does not keep) is zeroed after use. Nothing
 * here logs or writes anything.
 */
object SealedBox {
    const val PREFIX = "v1."
    const val EPK_LEN = 65
    const val IV_LEN = 12
    const val TAG_BITS = 128
    val INFO: ByteArray = "aethernet-tracker v1".toByteArray(Charsets.US_ASCII)

    /** The additional data each sealed item is bound to. */
    object Aad {
        fun agentKey(deviceId: String, store: Int) = "agentkey|$deviceId|$store"
        fun card(store: Int, wo: Long) = "card|$store|$wo"
        fun snapshot(store: Int, wo: Long) = "snapshot|$store|$wo"
    }

    class Parts(val epk: ByteArray, val iv: ByteArray, val ct: ByteArray)

    /** Splits a sealed string; throws [GeneralSecurityException] when it is not a v1 value. */
    fun parse(sealed: String): Parts {
        if (!sealed.startsWith(PREFIX)) throw GeneralSecurityException("not a v1 sealed value")
        val raw = try { Base64.getUrlDecoder().decode(sealed.substring(PREFIX.length)) } catch (e: IllegalArgumentException) { throw GeneralSecurityException("bad base64url", e) }
        if (raw.size < EPK_LEN + IV_LEN + TAG_BITS / 8 || raw[0] != 0x04.toByte()) throw GeneralSecurityException("sealed value too short")
        return Parts(raw.copyOfRange(0, EPK_LEN), raw.copyOfRange(EPK_LEN, EPK_LEN + IV_LEN), raw.copyOfRange(EPK_LEN + IV_LEN, raw.size))
    }

    /**
     * Opens [sealed] bound to [aad]. [agree] turns the sender's ephemeral public point (65 bytes) into the 32-byte ECDH secret:
     * the phone's Keystore key for a wrapped store key, or [softwareAgree] with a store private key for cards and snapshots.
     */
    fun open(sealed: String, aad: String, agree: (epk: ByteArray) -> ByteArray): ByteArray {
        val p = parse(sealed)
        val shared = agree(p.epk)
        val key = try { hkdfSha256(shared, p.epk, INFO, 32) } finally { shared.fill(0) }
        try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, p.iv))
            c.updateAAD(aad.toByteArray(Charsets.US_ASCII))
            return c.doFinal(p.ct)
        } finally {
            key.fill(0)
        }
    }

    /** Opens, gunzips and parses a card or snapshot with a store private key. */
    fun openJson(sealed: String, aad: String, storeKey: PrivateKey): JsonElement {
        val gz = open(sealed, aad) { epk -> softwareAgree(storeKey, epk) }
        val plain = try { gunzip(gz) } finally { gz.fill(0) }
        try {
            return Json.parseToJsonElement(plain.toString(Charsets.UTF_8))
        } finally {
            plain.fill(0)
        }
    }

    // ---- primitives ------------------------------------------------------------------------------------------------------------

    private val p256: ECParameterSpec by lazy {
        AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)
    }

    /** An uncompressed P-256 point (04|X|Y) as a JCA public key. */
    fun publicKeyFromPoint(point: ByteArray): ECPublicKey {
        if (point.size != EPK_LEN || point[0] != 0x04.toByte()) throw GeneralSecurityException("not an uncompressed P-256 point")
        val x = BigInteger(1, point.copyOfRange(1, 33))
        val y = BigInteger(1, point.copyOfRange(33, 65))
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), p256)) as ECPublicKey
    }

    /** ECDH in software (store keys): the 32-byte shared x coordinate. */
    fun softwareAgree(privateKey: PrivateKey, peerPoint: ByteArray): ByteArray {
        val ka = KeyAgreement.getInstance("ECDH")
        ka.init(privateKey)
        ka.doPhase(publicKeyFromPoint(peerPoint), true)
        return ka.generateSecret()
    }

    /** Imports a PKCS#8 P-256 private key (the plaintext of a wrapped store key). */
    fun importPkcs8(pkcs8: ByteArray): PrivateKey = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(pkcs8))

    /** RFC 5869 HKDF with HMAC-SHA256. */
    fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(if (salt.isEmpty()) ByteArray(32) else salt, "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        try {
            mac.init(SecretKeySpec(prk, "HmacSHA256"))
            val out = ByteArray(length)
            var t = ByteArray(0)
            var off = 0
            var i = 1
            while (off < length) {
                mac.update(t); mac.update(info); mac.update(i.toByte())
                val next = mac.doFinal()
                t.fill(0)
                t = next
                val n = minOf(t.size, length - off)
                System.arraycopy(t, 0, out, off, n)
                off += n; i++
            }
            t.fill(0)
            return out
        } finally {
            prk.fill(0)
        }
    }

    fun gunzip(bytes: ByteArray): ByteArray {
        val out = ByteArrayOutputStream(bytes.size * 4)
        GZIPInputStream(ByteArrayInputStream(bytes)).use { it.copyTo(out) }
        return out.toByteArray()
    }
}
