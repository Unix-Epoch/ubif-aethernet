package dev.aethernet.linkpearl.core.data

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.Serializable
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Encryption at rest for the token, the registration and the Home cache. androidx.security:security-crypto is deprecated from 1.1.0 on
 * (every API in it), so this is a small AES-256-GCM wrapper over a Keystore key that needs NO user authentication (background work
 * must read the token). Blob layout: 12-byte IV, then ciphertext with the 16-byte tag. The file name is bound in as additional data.
 */
interface SecretBox {
    fun seal(plain: ByteArray, aad: ByteArray): ByteArray
    /** Throws a GeneralSecurityException when the blob was tampered with, moved to another file, or the key is gone. */
    fun open(blob: ByteArray, aad: ByteArray): ByteArray
}

class AesGcmBox(private val key: () -> SecretKey) : SecretBox {
    override fun seal(plain: ByteArray, aad: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()); updateAAD(aad) }
        return c.iv + c.doFinal(plain)
    }

    override fun open(blob: ByteArray, aad: ByteArray): ByteArray {
        require(blob.size > IV + 16) { "blob too short" }
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, blob, 0, IV)); updateAAD(aad) }
        return c.doFinal(blob, IV, blob.size - IV)
    }

    private companion object { const val IV = 12 }
}

/** A box over a non-exportable AndroidKeyStore AES key [alias], created on first use. */
fun keystoreBox(alias: String): SecretBox = AesGcmBox {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getKey(alias, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
        init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build(),
        )
    }.generateKey()
}

/** One encrypted file, replaced atomically on every write. A file that cannot be opened (lost key, corruption) reads as absent. */
class EncryptedFile(private val file: File, private val box: SecretBox) {
    private val aad = file.name.toByteArray()

    @Synchronized
    fun read(): ByteArray? {
        if (!file.exists()) return null
        return try {
            box.open(file.readBytes(), aad)
        } catch (_: Exception) {
            file.delete()
            null
        }
    }

    @Synchronized
    fun write(bytes: ByteArray) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeBytes(box.seal(bytes, aad))
        Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
    }

    @Synchronized
    fun delete() { file.delete(); File(file.parentFile, file.name + ".tmp").delete() }
}

/**
 * What the phone remembers about its registration. [status] is "registering" (sent, answer not seen), "pending" or "active".
 * [revoked] stays after a removal so onboarding can say so once. The token is never printed: [toString] leaves it out.
 */
@Serializable
data class StoredSession(
    val deviceId: String? = null,
    val token: String? = null,
    val name: String = "",
    val fingerprint: String = "",
    val status: String = "",
    val stores: List<StoreRef> = emptyList(),
    /** store id -> wrapped store key from /me. */
    val keys: Map<Int, String> = emptyMap(),
    val revoked: Boolean = false,
    /** The stores' time zone from the last Home answer (see [StoreZone]). */
    val tz: String? = null,
) {
    val credentials: Credentials? get() = if (deviceId != null && token != null) Credentials(deviceId, token) else null
    override fun toString() = "StoredSession(deviceId=$deviceId, name=$name, status=$status, stores=${stores.map { it.id }})"
}

/** The Bearer credentials. [toString] never shows the token. */
class Credentials(val id: String, token: String) {
    private val secret = token
    val bearer: String get() = "Bearer $id.$secret"
    internal val tokenValue: String get() = secret
    override fun toString() = "Credentials(id=$id)"
}

/** [StoredSession] in an [EncryptedFile], with an in-memory copy that the rest of the app reads. */
class SessionStore(private val file: EncryptedFile) {
    private val _flow = MutableStateFlow(load())
    val flow: StateFlow<StoredSession> get() = _flow
    val current: StoredSession get() = _flow.value

    private fun load(): StoredSession = try {
        file.read()?.let { LinkpearlJson.decodeFromString(StoredSession.serializer(), it.decodeToString()) } ?: StoredSession()
    } catch (_: Exception) {
        StoredSession()
    }

    @Synchronized
    fun update(change: (StoredSession) -> StoredSession): StoredSession {
        val next = change(_flow.value)
        if (next == StoredSession()) file.delete() else file.write(LinkpearlJson.encodeToString(StoredSession.serializer(), next).toByteArray())
        _flow.value = next
        return next
    }
}
