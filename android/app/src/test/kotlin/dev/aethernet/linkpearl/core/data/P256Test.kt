package dev.aethernet.linkpearl.core.data

import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec

/** The JWK encoding and the ECDH secret against the server's own test vector (tracker-worker/MOBILE-API-wo.md, a throwaway TEST key). */
class P256Test {
    private val storePkcs8 = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgj7zkPtASOtqIrFPoNpVgvyq-isqyjIiXfChJly3kkvehRANCAATukLv1ZEl6KV_vINoEQwkqbIn2D8vIAf7vWLDbYhthTCAMMnVYF4LQo-T3B_kq5_3lH3gv1-UVUVl8z6M-hemF"
    private val storeX = "7pC79WRJeilf7yDaBEMJKmyJ9g_LyAH-71iw22IbYUw"
    private val storeY = "IAwydVgXgtCj5PcH-Srn_eUfeC_X5RVRWXzPoz6F6YU"
    private val card = "v1.BOk3HTerTewDZNoHNFtu78uZQ9gBIo1zwU-nckLZkXC6ZTNFlJ9R2-zh7s997jswBl5a5QpThsFq8eCGzGcnsmBo7TUjdz_f5Zln-bUwvJKkKO3duddXkpz7ZxLzIF-tjuPbjMrvy-Z9eLkyTgiZiham3U9QVAC9Pz3Ujl_4jysrqgcQ7GGF_EowscY_-mNVLKXXieYgRTy0gJXGFBpIb3Yh63PxHKkbDjvySHPz8J42fi_3y9oQxMlkM7_ohzUHYkxFn8Xlnne0MB06nshBBL-iK_tXrjmi30Uvxo0I6nV1W-XWNeEivtSF4-mrwqWQZ7dzBzwYUiADwSMMwApW"

    private val priv = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(unb64u(storePkcs8)))

    @Test fun jwkOfTheVectorsPublicKeyMatchesTheDocumentedOne() {
        val pub = P256.publicFromUncompressed(byteArrayOf(4) + unb64u(storeX) + unb64u(storeY))
        val jwk = P256.jwk(pub)
        assertEquals("EC", jwk["kty"]!!.jsonPrimitive.content)
        assertEquals("P-256", jwk["crv"]!!.jsonPrimitive.content)
        assertEquals(storeX, jwk["x"]!!.jsonPrimitive.content)
        assertEquals(storeY, jwk["y"]!!.jsonPrimitive.content)
        assertEquals(setOf("kty", "crv", "x", "y"), jwk.keys)
    }

    @Test fun ecdhPlusHkdfOpensTheServersSealedCard() {
        // Same steps the phone runs after DeviceIdentity.agree: raw ECDH secret -> HKDF-SHA256(salt = epk, info) -> AES-GCM -> gunzip.
        val json = gunzip(openSealed(card, "card|914|700000123") { P256.agree(priv, it) }).decodeToString()
        assertEquals(
            """{"name":"Sam Sample","customerId":"C-TEST-1","phones":["5555550123"],"emails":["sam.sample@example.com"],"imei":"490154203237518","serial":"F2LTESTSERIAL","claim":"CLM-TEST-1"}""",
            json,
        )
    }

    @Test fun aWrongAadFails() {
        try { openSealed(card, "card|914|700000124") { P256.agree(priv, it) }; throw AssertionError("opened with the wrong aad") } catch (_: java.security.GeneralSecurityException) {}
    }

    @Test fun sharedSecretIs32BytesAndSymmetric() {
        fun pair() = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val a = pair(); val b = pair()
        fun raw(p: java.security.KeyPair): ByteArray { val w = (p.public as ECPublicKey).w; return byteArrayOf(4) + P256.fixed32(w.affineX) + P256.fixed32(w.affineY) }
        val ab = P256.agree(a.private, raw(b)); val ba = P256.agree(b.private, raw(a))
        assertEquals(32, ab.size)
        assertTrue(ab.contentEquals(ba))
    }

    @Test fun coordinatesAreAlwaysFortyThreeUnpaddedCharsEvenWithLeadingZeroBytes() {
        assertEquals(32, P256.fixed32(BigInteger.valueOf(5)).size)
        assertEquals(32, P256.fixed32(BigInteger(1, ByteArray(32) { 0xFF.toByte() })).size) // toByteArray adds a sign byte here
        var shortSeen = 0
        val gen = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }
        repeat(1500) {
            val pub = gen.generateKeyPair().public as ECPublicKey
            val jwk = P256.jwk(pub)
            for (k in listOf("x", "y")) {
                val s = jwk[k]!!.jsonPrimitive.content
                assertEquals(43, s.length); assertFalse(s.contains('=') || s.contains('+') || s.contains('/'))
            }
            if (pub.w.affineX.toByteArray().size < 32) shortSeen++
        }
        assertTrue("expected some keys with a short coordinate in 1500 tries", shortSeen > 0)
    }

    @Test fun peerKeysThatAreNotPointsAreRefused() {
        for (bad in listOf(ByteArray(64), ByteArray(65), byteArrayOf(4) + ByteArray(64) { 1 })) {
            try { P256.publicFromUncompressed(bad); throw AssertionError("accepted") } catch (_: IllegalArgumentException) {}
        }
    }
}
