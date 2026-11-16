package dev.aethernet.linkpearl.feature.update

import java.io.File
import java.security.MessageDigest

/** Test doubles for the update logic: a scripted server, a downloader that writes given bytes, an installer that records. */
class FakeUpdateSource(var answer: UpdateAnswer?) : UpdateSource {
    var calls = 0
    override suspend fun check(): UpdateAnswer? { calls++; return answer }
}

class FakeDownloader(var bytes: ByteArray, var ok: Boolean = true) : ApkDownloader {
    var calls = 0
    val progress = mutableListOf<Long>()
    override suspend fun download(release: Release, into: File, onProgress: (Long) -> Unit): Boolean {
        calls++
        into.writeBytes(bytes)
        val half = bytes.size / 2L
        onProgress(half); progress += half
        kotlinx.coroutines.yield()
        onProgress(bytes.size.toLong()); progress += bytes.size.toLong()
        return ok
    }
}

class FakeInstaller(var allowed: Boolean = true, var starts: Boolean = true) : ApkInstaller {
    val installed = mutableListOf<File>()
    override fun canInstall() = allowed
    override suspend fun install(apk: File): Boolean { installed += apk; return starts }
}

class MemoryUpdateStore(var saved: UpdateStore.Saved? = null) : UpdateStore {
    override suspend fun load() = saved
    override suspend fun save(saved: UpdateStore.Saved) { this.saved = saved }
}

fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

val ApkBytes = ByteArray(300_000) { (it % 251).toByte() }
val Release120 = Release(code = 6, name = "1.2.0", size = ApkBytes.size.toLong(), sha256 = sha256(ApkBytes))
val Current = AppVersion(4, "1.1.1")
