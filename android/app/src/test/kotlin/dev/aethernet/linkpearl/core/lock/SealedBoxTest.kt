package dev.aethernet.linkpearl.core.lock

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.security.GeneralSecurityException
import java.security.interfaces.ECPublicKey
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class SealedBoxTest {
    private fun hex(s: String) = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private fun ByteArray.hex() = joinToString("") { "%02x".format(it) }

    // ---- known answers ----------------------------------------------------------------------------------------------------

    @Test fun hkdfMatchesRfc5869Case1() {
        val okm = SealedBox.hkdfSha256(ByteArray(22) { 0x0b }, hex("000102030405060708090a0b0c"), hex("f0f1f2f3f4f5f6f7f8f9"), 42)
        assertEquals("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865", okm.hex())
    }

    @Test fun hkdfMatchesRfc5869Case3EmptySaltAndInfo() {
        val okm = SealedBox.hkdfSha256(ByteArray(22) { 0x0b }, ByteArray(0), ByteArray(0), 42)
        assertEquals("8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8", okm.hex())
    }

    @Test fun aesGcmMatchesGcmSpecCases13And14() {
        val key = SecretKeySpec(ByteArray(32), "AES")
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, ByteArray(12)))
        assertEquals("530f8afbc74536b9a963b4f1c4cb738b", c.doFinal().hex())
        val c2 = Cipher.getInstance("AES/GCM/NoPadding")
        c2.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, ByteArray(12)))
        assertEquals("cea7403d4d606b6e074ec5d3baf39d18" + "d0d1c8a799996bf0265b98b5d48ab919", c2.doFinal(ByteArray(16)).hex())
    }

    // ---- the server's test vector (path b: store key in software) ------------------------------------------------------------

    @Test fun vectorCardOpensToTheExactJson() {
        val gz = SealedBox.open(TestCrypto.VECTOR_CARD, SealedBox.Aad.card(914, 700000123)) { SealedBox.softwareAgree(TestCrypto.vectorStoreKey(), it) }
        assertEquals(TestCrypto.VECTOR_CARD_JSON, SealedBox.gunzip(gz).toString(Charsets.UTF_8))
        val json = SealedBox.openJson(TestCrypto.VECTOR_CARD, "card|914|700000123", TestCrypto.vectorStoreKey()).jsonObject
        assertEquals("Sam Sample", json["name"]!!.jsonPrimitive.content)
    }

    @Test fun vectorSnapshotOpensToTheExpectedJson() {
        val j = SealedBox.openJson(TestCrypto.VECTOR_SNAPSHOT, SealedBox.Aad.snapshot(914, 700000123), TestCrypto.vectorStoreKey()).jsonObject
        val wo = j["workorder"]!!.jsonObject["workorder"]!!.jsonObject
        assertEquals(700000123, wo["workorderId"]!!.jsonPrimitive.int)
        assertEquals("490154203237518", wo["CustomerDevice"]!!.jsonObject["imei"]!!.jsonPrimitive.content)
        val notes = j["notes"]!!.jsonObject["notes"]!!.jsonArray
        assertEquals(2, notes.size)
        assertEquals("Customer asked for a text when it is ready.", notes[0].jsonObject["noteText"]!!.jsonPrimitive.content)
        assertEquals("555-555-0123", j["customer_data"]!!.jsonObject["CustomerDataPhones"]!!.jsonArray[0].jsonObject["phone"]!!.jsonPrimitive.content)
        assertEquals(Json.parseToJsonElement("199"), j["cart"]!!.jsonObject["payment"]!!.jsonObject["total"])
    }

    @Test fun vectorCardWithTheWrongAadFails() {
        try {
            SealedBox.openJson(TestCrypto.VECTOR_CARD, "snapshot|914|700000123", TestCrypto.vectorStoreKey()); fail()
        } catch (_: GeneralSecurityException) {}
        try {
            SealedBox.openJson(TestCrypto.VECTOR_CARD, "card|914|700000124", TestCrypto.vectorStoreKey()); fail()
        } catch (_: GeneralSecurityException) {}
    }

    @Test fun malformedValuesAreRejected() {
        for (bad in listOf("", "v2.abc", "v1.", "v1.!!!", "v1.AAAA")) {
            try { SealedBox.parse(bad); fail(bad) } catch (_: GeneralSecurityException) {}
        }
    }

    // ---- path a: a wrapped store key, opened through an agree() function (the Keystore key on the phone) ---------------------

    @Test fun wrappedStoreKeyRoundTripsThroughAgree() {
        val device = TestCrypto.newKeyPair()
        val aad = SealedBox.Aad.agentKey("a1".repeat(16), 914)
        val wrapped = TestCrypto.seal(TestCrypto.vectorPkcs8(), device.public as ECPublicKey, aad)
        var agreed = 0
        val pkcs8 = SealedBox.open(wrapped, aad) { epk -> agreed++; SealedBox.softwareAgree(device.private, epk) }
        assertEquals(1, agreed)
        assertArrayEquals(TestCrypto.vectorPkcs8(), pkcs8)
        // and the unwrapped key opens the vector card
        val ring = Keyring().apply { put(914, pkcs8) }
        assertEquals("Sam Sample", ring.openJson(914, TestCrypto.VECTOR_CARD, "card|914|700000123").jsonObject["name"]!!.jsonPrimitive.content)
        try { SealedBox.open(wrapped, SealedBox.Aad.agentKey("a1".repeat(16), 326)) { SealedBox.softwareAgree(device.private, it) }; fail() } catch (_: GeneralSecurityException) {}
    }

    @Test fun keyringClearZeroesKeyBytes() {
        val bytes = TestCrypto.vectorPkcs8()
        val ring = Keyring().apply { put(914, bytes) }
        assertTrue(ring.hasKey(914))
        ring.clear()
        assertFalse(ring.hasKey(914))
        assertTrue(bytes.all { it == 0.toByte() })
        try { ring.openJson(914, TestCrypto.VECTOR_CARD, "card|914|700000123"); fail() } catch (_: NoStoreKeyException) {}
    }

    @Test fun ourSealOpensWithTheVectorPathToo() {
        val store = TestCrypto.newKeyPair()
        val sealed = TestCrypto.sealJson("""{"a":1}""", store.public as ECPublicKey, "card|1|2")
        assertEquals(1, SealedBox.openJson(sealed, "card|1|2", store.private).jsonObject["a"]!!.jsonPrimitive.int)
    }
}
