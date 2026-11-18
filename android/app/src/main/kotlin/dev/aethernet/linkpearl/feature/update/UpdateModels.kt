package dev.aethernet.linkpearl.feature.update

import dev.aethernet.linkpearl.core.data.LinkpearlJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import java.io.File
import java.security.MessageDigest
import java.util.Locale

/** The published build (`latest` of `GET /v1/agents/m/update`, tracker-worker/MOBILE-API-update.md). */
@Serializable
data class Release(val code: Int, val name: String, val size: Long, val sha256: String, val notes: String? = null) {
    /** A shape the app can download and verify: a positive size and a 64-hex SHA-256. */
    val usable: Boolean get() = code > 0 && size > 0 && SHA256_HEX.matches(sha256)
}

/** The oldest build the server accepts (`min` of /m/update, `minApp` of /m/prefs). */
@Serializable
data class MinVersion(val code: Int, val name: String)

/** The answer of `GET /v1/agents/m/update`. A `latest` that cannot be verified is dropped (treated as nothing published). */
@Serializable
data class UpdateAnswer(val latest: Release? = null, val min: MinVersion? = null) {
    companion object {
        fun parse(json: JsonElement?): UpdateAnswer? {
            val o = json as? JsonObject ?: return null
            val a = try { LinkpearlJson.decodeFromJsonElement<UpdateAnswer>(o) } catch (_: Exception) {
                // A malformed `latest` must not hide `min`.
                val min = runCatching { o["min"]?.let { LinkpearlJson.decodeFromJsonElement<MinVersion>(it) } }.getOrNull()
                return UpdateAnswer(null, min)
            }
            return a.copy(latest = a.latest?.takeIf { it.usable })
        }
    }
}

/** This build (BuildConfig.VERSION_CODE / VERSION_NAME). */
data class AppVersion(val code: Int, val name: String)

/** Where the update stands. Only one download or install runs at a time. */
sealed interface UpdatePhase {
    data object Idle : UpdatePhase
    data class Downloading(val bytes: Long, val total: Long) : UpdatePhase {
        val fraction: Float get() = if (total <= 0) 0f else (bytes.toFloat() / total).coerceIn(0f, 1f)
    }
    data object Verifying : UpdatePhase
    /** Waiting for "Install unknown apps" to be allowed for Linkpearl (Android's settings page is open). */
    data object NeedsPermission : UpdatePhase
    /** Handed to Android's package installer (its confirm dialog may be showing). */
    data object Installing : UpdatePhase
    data class Failed(val message: String) : UpdatePhase

    companion object {
        const val DOWNLOAD_FAILED = "Download failed"
        const val INSTALL_FAILED = "Install failed"
    }
}

/** The Check for updates button's last result. */
enum class CheckStatus { Idle, Checking, UpToDate, Failed }

data class UpdateState(
    val current: AppVersion,
    val latest: Release? = null,
    val min: MinVersion? = null,
    val phase: UpdatePhase = UpdatePhase.Idle,
    val checkStatus: CheckStatus = CheckStatus.Idle,
) {
    /** A newer build is published: Settings shows the update row and the nav shows a dot. */
    val available: Boolean get() = latest != null && latest.code > current.code

    /** This build is older than the server accepts: the app is blocked behind "Update needed". */
    val required: Boolean get() = min != null && current.code < min.code

    /** The version name an update goes to ("1.2.0"): the published build, else the server's minimum. */
    val targetName: String? get() = latest?.takeIf { available }?.name ?: min?.takeIf { required }?.name

    val busy: Boolean get() = phase is UpdatePhase.Downloading || phase == UpdatePhase.Verifying || phase == UpdatePhase.Installing
}

/** What Android's package installer reported for a session (see [UpdateInstallReceiver]). */
enum class InstallStatus { Success, Aborted, Failure }

internal val SHA256_HEX = Regex("^[0-9a-fA-F]{64}$")

/** SHA-256 of a downloaded APK, and the check the server's contract asks for: byte count equals `size` and the hash equals `sha256`. */
object ApkVerify {
    fun sha256Hex(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { String.format(Locale.US, "%02x", it) }
    }

    fun matches(file: File, release: Release): Boolean =
        file.isFile && file.length() == release.size && sha256Hex(file).equals(release.sha256, ignoreCase = true)
}

/** "2.5 of 4.1 MB" and "62%" under the progress bar. */
object UpdateFmt {
    private fun mb(bytes: Long): String = String.format(Locale.US, "%.1f", bytes / 1_000_000.0)
    fun progress(bytes: Long, total: Long): String = "${mb(bytes.coerceAtMost(total))} of ${mb(total)} MB"
    fun percent(fraction: Float): String = "${kotlin.math.round(fraction * 100).toInt()}%"
}
