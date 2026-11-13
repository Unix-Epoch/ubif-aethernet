package dev.aethernet.linkpearl.core.data

import android.app.KeyguardManager
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.ProviderException
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.util.Base64
import javax.crypto.KeyAgreement

/** How long after a biometric or device-credential success the device key may be used (seconds). */
const val AUTH_VALIDITY_SECONDS = 30

/**
 * This phone's cryptographic identity: an EC P-256 key pair in the Android Keystore, non-exportable, used ONLY for ECDH to open the
 * wrapped store keys (MOBILE-API.md "Sealed data"). It never authenticates requests (the bearer token does), so background work never
 * needs it.
 */
interface DeviceIdentity {
    /** The 32-hex id sent at registration; null before the first registration. */
    val deviceId: String?
    /** {kty:"EC",crv:"P-256",x,y} (43-char unpadded base64url coordinates). Creates the key pair on first call. */
    fun publicJwk(): JsonObject
    /**
     * Raw 32-byte ECDH shared secret between this phone's private key and [peerPublic] (a 65-byte uncompressed P-256 point).
     * The key requires recent user authentication: throws android.security.keystore.UserNotAuthenticatedException when the user
     * has not authenticated (biometric or device credential) within [AUTH_VALIDITY_SECONDS]. Never exports the private key.
     */
    fun agree(peerPublic: ByteArray): ByteArray
    /** True when the phone has a secure lock screen so the key could be created with user authentication required. */
    val requiresUserAuth: Boolean
}

/** [DeviceIdentity] plus what registration needs: dropping the key pair so the next registration gets a new one. */
interface ManagedIdentity : DeviceIdentity {
    fun reset()
}

/** P-256 encodings shared by the Keystore identity and the JVM tests (which use a software key). Pure JCA, no Android classes. */
object P256 {
    val params: ECParameterSpec by lazy {
        AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)
    }

    /** A coordinate as exactly 32 bytes: BigInteger drops leading zeros (and may add a sign byte), so strip and left-pad. */
    fun fixed32(v: BigInteger): ByteArray {
        val raw = v.toByteArray().let { if (it.size > 32 && it[0] == 0.toByte()) it.copyOfRange(it.size - 32, it.size) else it }
        require(raw.size <= 32) { "coordinate too long" }
        return ByteArray(32 - raw.size) + raw
    }

    fun b64u(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    /** `{kty:"EC",crv:"P-256",x,y}` for a public key. */
    fun jwk(pub: ECPublicKey): JsonObject = JsonObject(
        mapOf(
            "kty" to JsonPrimitive("EC"), "crv" to JsonPrimitive("P-256"),
            "x" to JsonPrimitive(b64u(fixed32(pub.w.affineX))), "y" to JsonPrimitive(b64u(fixed32(pub.w.affineY))),
        ),
    )

    /** A 65-byte uncompressed point (04 || X || Y) as a public key; throws IllegalArgumentException when malformed or off the curve. */
    fun publicFromUncompressed(bytes: ByteArray): ECPublicKey {
        require(bytes.size == 65 && bytes[0] == 4.toByte()) { "peer key must be a 65-byte uncompressed P-256 point" }
        val x = BigInteger(1, bytes.copyOfRange(1, 33))
        val y = BigInteger(1, bytes.copyOfRange(33, 65))
        // On the curve? (Some providers do not check; a point off the curve must never reach the key agreement.)
        val p = (params.curve.field as java.security.spec.ECFieldFp).p
        require(x < p && y < p && y.multiply(y).mod(p) == x.pow(3).add(params.curve.a.multiply(x)).add(params.curve.b).mod(p)) { "peer key is not a valid P-256 point" }
        return try {
            KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), params)) as ECPublicKey
        } catch (e: java.security.GeneralSecurityException) {
            throw IllegalArgumentException("peer key is not a valid P-256 point", e)
        }
    }

    /** The raw ECDH shared secret (32 bytes: the x coordinate of the shared point), for any private key including a Keystore one. */
    fun agree(privateKey: PrivateKey, peerPublic: ByteArray): ByteArray {
        val ka = KeyAgreement.getInstance("ECDH")
        ka.init(privateKey)
        ka.doPhase(publicFromUncompressed(peerPublic), true)
        return ka.generateSecret()
    }
}

/**
 * The real identity. The key pair (alias [ALIAS]) is created on the first [publicJwk] call: AGREE_KEY only, StrongBox when the phone has
 * one (TEE otherwise), and, when the phone has a secure lock screen, usable only within [AUTH_VALIDITY_SECONDS] of a strong biometric or
 * device-credential success (invalidated by new biometric enrolment, the platform default). Without a lock screen the key is created
 * without that requirement and [requiresUserAuth] is false.
 */
class KeystoreDeviceIdentity(private val context: Context, private val session: SessionStore) : ManagedIdentity {
    override val deviceId: String? get() = session.current.deviceId

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    override val requiresUserAuth: Boolean
        get() {
            val key = runCatching { keyStore().getKey(ALIAS, null) as? PrivateKey }.getOrNull()
                ?: return context.getSystemService(KeyguardManager::class.java)?.isDeviceSecure == true
            return runCatching {
                (KeyFactory.getInstance(key.algorithm, "AndroidKeyStore").getKeySpec(key, KeyInfo::class.java) as KeyInfo).isUserAuthenticationRequired
            }.getOrDefault(false)
        }

    @Synchronized
    override fun publicJwk(): JsonObject {
        val ks = keyStore()
        if (!ks.containsAlias(ALIAS)) generate()
        val cert = ks.getCertificate(ALIAS) ?: error("device key has no certificate")
        return P256.jwk(cert.publicKey as ECPublicKey)
    }

    override fun agree(peerPublic: ByteArray): ByteArray {
        val key = keyStore().getKey(ALIAS, null) as? PrivateKey ?: error("no device key yet: register first")
        return P256.agree(key, peerPublic)
    }

    @Synchronized
    override fun reset() {
        runCatching { keyStore().deleteEntry(ALIAS) }
    }

    private fun generate() {
        val secure = context.getSystemService(KeyguardManager::class.java)?.isDeviceSecure == true
        fun spec(strongBox: Boolean): KeyGenParameterSpec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_AGREE_KEY)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .apply {
                if (secure) {
                    setUserAuthenticationRequired(true)
                    setUserAuthenticationParameters(AUTH_VALIDITY_SECONDS, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
                }
                if (strongBox) setIsStrongBoxBacked(true)
            }.build()
        fun make(strongBox: Boolean) = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply { initialize(spec(strongBox)) }.generateKeyPair()
        try {
            make(strongBox = true)
        } catch (_: StrongBoxUnavailableException) {
            make(strongBox = false)
        } catch (_: ProviderException) { // some devices report a missing StrongBox this way
            make(strongBox = false)
        }
    }

    companion object { const val ALIAS = "linkpearl-device-v1" }
}
