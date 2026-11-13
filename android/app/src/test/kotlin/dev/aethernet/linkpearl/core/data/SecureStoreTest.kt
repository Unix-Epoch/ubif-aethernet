package dev.aethernet.linkpearl.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class SecureStoreTest {
    private val id = "ab".repeat(16)
    private val token = "cd".repeat(32)

    @Test fun theTokenIsNotInTheFileInAnyForm() {
        val dir = tempDir(); val store = newSessionStore(dir)
        store.update { it.copy(deviceId = id, token = token, name = "Pixel Fold", status = "pending") }
        val bytes = File(dir, "session.bin").readBytes()
        val text = String(bytes, Charsets.ISO_8859_1)
        assertFalse(text.contains(token)); assertFalse(text.contains(id)); assertFalse(text.contains("Pixel"))
        // and it comes back from disk
        val again = newSessionStore(dir)
        assertEquals(token, again.current.token); assertEquals("Pixel Fold", again.current.name)
        assertEquals("Bearer $id.$token", again.current.credentials!!.bearer)
    }

    @Test fun aTamperedOrMovedFileReadsAsEmpty() {
        val dir = tempDir(); val store = newSessionStore(dir)
        store.update { it.copy(deviceId = id, token = token, status = "pending") }
        val f = File(dir, "session.bin")
        val bytes = f.readBytes(); bytes[bytes.size - 3] = (bytes[bytes.size - 3] + 1).toByte(); f.writeBytes(bytes)
        assertNull(newSessionStore(dir).current.token)
        assertFalse(f.exists()) // the unreadable file is deleted

        store.update { it.copy(deviceId = id, token = token, status = "pending") }
        File(dir, "other.bin").writeBytes(File(dir, "session.bin").readBytes()) // bound to its own name: another file name does not open it
        assertNull(newSessionStore(dir, "other.bin").current.token)
    }

    @Test fun anEmptySessionRemovesTheFile() {
        val dir = tempDir(); val store = newSessionStore(dir)
        store.update { it.copy(token = token, deviceId = id) }
        assertTrue(File(dir, "session.bin").exists())
        store.update { StoredSession() }
        assertFalse(File(dir, "session.bin").exists())
    }

    @Test fun twoSealsOfTheSameTextDiffer() {
        val a = testBox.seal("x".toByteArray(), "n".toByteArray()); val b = testBox.seal("x".toByteArray(), "n".toByteArray())
        assertFalse(a.contentEquals(b))
    }

    @Test fun noSourceInCoreDataLogs() {
        // The token must never reach a log: the data layer has no logging at all.
        val root = File("src/main/kotlin/dev/aethernet/linkpearl/core/data")
        val offenders = root.walkTopDown().filter { it.extension == "kt" }.filter { f -> f.readLines().any { Regex("""\bLog\.|println\(|printStackTrace|Timber""").containsMatchIn(it) } }.map { it.name }.toList()
        assertTrue("logging found in $offenders", offenders.isEmpty())
    }
}
