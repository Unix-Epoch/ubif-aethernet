package dev.aethernet.linkpearl.core.lock

import kotlinx.serialization.json.JsonElement
import java.security.PrivateKey

/**
 * The unwrapped store private keys, in memory only, while unlocked. [clear] zeroes the PKCS#8 bytes and drops the key objects
 * (the JCA key's own BigInteger cannot be wiped; dropping every reference is the best the platform allows).
 */
class Keyring : SealedOpener {
    private class Entry(val pkcs8: ByteArray, val key: PrivateKey)

    private val entries = HashMap<Int, Entry>()

    /** Takes ownership of [pkcs8] (it is zeroed on [clear]). */
    @Synchronized
    fun put(store: Int, pkcs8: ByteArray) {
        val key = SealedBox.importPkcs8(pkcs8)
        entries.put(store, Entry(pkcs8, key))?.pkcs8?.fill(0)
    }

    @Synchronized
    fun stores(): Set<Int> = entries.keys.toSet()

    @Synchronized
    fun clear() {
        entries.values.forEach { it.pkcs8.fill(0) }
        entries.clear()
    }

    @Synchronized
    override fun hasKey(store: Int): Boolean = store in entries

    override fun openJson(store: Int, sealed: String, aad: String): JsonElement {
        val key = synchronized(this) { entries[store]?.key } ?: throw NoStoreKeyException(store)
        return SealedBox.openJson(sealed, aad, key)
    }
}
