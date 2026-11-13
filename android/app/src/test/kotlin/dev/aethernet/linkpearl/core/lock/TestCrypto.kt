package dev.aethernet.linkpearl.core.lock

import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import java.util.zip.GZIPOutputStream
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Test-only sealing, written from tracker-worker/src/crypto.js `sealBytes` (the phone never seals). */
object TestCrypto {
    /** The server doc's throwaway store key (MOBILE-API-wo.md test vector). TEST KEY ONLY. */
    const val VECTOR_STORE_PKCS8 = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgj7zkPtASOtqIrFPoNpVgvyq-isqyjIiXfChJly3kkvehRANCAATukLv1ZEl6KV_vINoEQwkqbIn2D8vIAf7vWLDbYhthTCAMMnVYF4LQo-T3B_kq5_3lH3gv1-UVUVl8z6M-hemF"
    const val VECTOR_CARD = "v1.BOk3HTerTewDZNoHNFtu78uZQ9gBIo1zwU-nckLZkXC6ZTNFlJ9R2-zh7s997jswBl5a5QpThsFq8eCGzGcnsmBo7TUjdz_f5Zln-bUwvJKkKO3duddXkpz7ZxLzIF-tjuPbjMrvy-Z9eLkyTgiZiham3U9QVAC9Pz3Ujl_4jysrqgcQ7GGF_EowscY_-mNVLKXXieYgRTy0gJXGFBpIb3Yh63PxHKkbDjvySHPz8J42fi_3y9oQxMlkM7_ohzUHYkxFn8Xlnne0MB06nshBBL-iK_tXrjmi30Uvxo0I6nV1W-XWNeEivtSF4-mrwqWQZ7dzBzwYUiADwSMMwApW"
    const val VECTOR_CARD_JSON = """{"name":"Sam Sample","customerId":"C-TEST-1","phones":["5555550123"],"emails":["sam.sample@example.com"],"imei":"490154203237518","serial":"F2LTESTSERIAL","claim":"CLM-TEST-1"}"""
    const val VECTOR_SNAPSHOT = "v1.BOg1CDkIgRBq-zZmfoPa9Vm715qQK7I_-3Wc9ROFADKXXlyrYeiVBkYbs7KfkT4o45Lyjdqkf1xcMc3VN5apTZ06-FDA0au6G2Ud_bBNNw4EoD_P3AZtjtetfsn5eHl8Bckt8m3ai3Sw-r_kd80M0STXufzyQCNZlXZtjbNQ2GMxPAYDToJWuJKn3NlwUjctKzu3uAtlVFzmYnVl21JOnxhF2sddUxlgQcjgxfOdSYi5sZTk00ZvMIY8WCjm8T7Xn1Nv2LDHlsY9_CMh3Mufj-qmb1sLfSngnuDpxfIC5_m8yyQkPfOb9EePMNzEtnMiukXGvrSxpVgpfy0Js5n6GgsU3bLb9UAQvY4AkqVkARLe6g8DGsqcgudejMQLk4fZK2tIwiNMWmZ_owZfhtABPAv0tvBvjF6GR2d7gDPGjDyGUsFGG-P4GwMdsvLM3PxUKKZe2QgZCYgvYVqpaRq2f6Te0pWOb8A03YwSNUc9NaYtwkH8-iGrGU3OqN6j3JIOWQhnwvtWRBqwGYqXk46Bcf9ZolZzfGuHI0K0F_KZ9oZhsM2eRi8tACFByhZ5n3BQSBsRbh4rKSifs-FP4UFNSB3BdKZVyAdWt2RLtW8_2B87QK7K_q2dFzCCr4yp7IWFdlZj_0V51AEHfMHz4qFF1pjDdOAZAXSynl1h6AGoAFzW9Uli_rrtooYJJOZHaQySExkRJuHyTGddtW3xsK2MQ9cVuzBv_z6Uu0UAEYJa1yJzwV2oEHCju5V4fJQzKR8200ZKjLTLH0fdD5Bc3VJ3oeKV95X7ig9XjfZe8TAkhw6ycJvW-zxzgPhUcwam8nHL5dqm3qa-HXc"
    const val VECTOR_STORE = 914
    const val VECTOR_WO = 700000123L

    fun vectorPkcs8(): ByteArray = Base64.getUrlDecoder().decode(VECTOR_STORE_PKCS8)
    fun vectorStoreKey(): PrivateKey = SealedBox.importPkcs8(vectorPkcs8())

    fun newKeyPair(): KeyPair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()

    fun point(pub: ECPublicKey): ByteArray {
        fun pad(b: BigInteger): ByteArray { val raw = b.toByteArray().dropWhile { it == 0.toByte() }.toByteArray(); return ByteArray(32 - raw.size) + raw }
        return byteArrayOf(4) + pad(pub.w.affineX) + pad(pub.w.affineY)
    }

    fun gzip(b: ByteArray): ByteArray = ByteArrayOutputStream().also { o -> GZIPOutputStream(o).use { it.write(b) } }.toByteArray()

    /** sealBytes: fresh ephemeral key, ECDH with [recipient], HKDF(salt = epk), AES-256-GCM with [aad]. */
    fun seal(bytes: ByteArray, recipient: ECPublicKey, aad: String): String {
        val eph = newKeyPair()
        val epk = point(eph.public as ECPublicKey)
        val shared = SealedBox.softwareAgree(eph.private, point(recipient))
        val key = SealedBox.hkdfSha256(shared, epk, SealedBox.INFO, 32)
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        c.updateAAD(aad.toByteArray(Charsets.US_ASCII))
        val ct = c.doFinal(bytes)
        return "v1." + Base64.getUrlEncoder().withoutPadding().encodeToString(epk + iv + ct)
    }

    fun sealJson(json: String, recipient: ECPublicKey, aad: String): String = seal(gzip(json.toByteArray()), recipient, aad)
}
