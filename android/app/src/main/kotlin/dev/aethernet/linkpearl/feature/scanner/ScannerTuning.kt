package dev.aethernet.linkpearl.feature.scanner

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.google.mlkit.vision.barcode.common.Barcode
import dev.aethernet.linkpearl.core.data.LinkpearlJson
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.serialization.Serializable

/** The two scanner setups: serial labels (1D codes, a wide strip) and QR (Linkshell pairing, a square). */
enum class ScanKind(val key: String, val label: String) {
    Labels("labels", "Labels"), Qr("qr", "QR");

    companion object {
        fun of(formats: List<Int>): ScanKind = if (Barcode.FORMAT_QR_CODE in formats) Qr else Labels
    }
}

/** The scanning area as fractions (0..1) of the viewfinder. Codes count only when their centre is inside it. */
@Serializable
data class ScanArea(val left: Float, val top: Float, val right: Float, val bottom: Float) {
    /** Kept inside the viewfinder and at least [MIN] wide and tall. */
    fun clamped(): ScanArea {
        val l = left.coerceIn(0f, 1f - MIN); val t = top.coerceIn(0f, 1f - MIN)
        return ScanArea(l, t, right.coerceIn(l + MIN, 1f), bottom.coerceIn(t + MIN, 1f))
    }

    fun contains(x: Float, y: Float): Boolean = x in left..right && y in top..bottom

    companion object { const val MIN = 0.1f }
}

/**
 * How a scanner feels. [hold]: frames in a row that must read the same code before it counts; [repeatMs]: how long before the same
 * code can count again; [zoom]: the camera's zoom ratio (capped by the camera); [light]: the torch; [vibrate] and [sound] on each scan.
 */
@Serializable
data class ScanTuning(
    val area: ScanArea,
    val zoom: Float = 1f,
    val hold: Int = 1,
    val repeatMs: Long = 1500,
    val light: Boolean = false,
    val vibrate: Boolean = false,
    val sound: Boolean = false,
) {
    fun clamped(): ScanTuning = copy(
        area = area.clamped(), zoom = zoom.coerceIn(ZOOM_MIN, ZOOM_MAX), hold = hold.coerceIn(HOLD_MIN, HOLD_MAX),
        repeatMs = repeatMs.coerceIn(REPEAT_MIN, REPEAT_MAX),
    )

    companion object {
        const val ZOOM_MIN = 1f; const val ZOOM_MAX = 4f
        const val HOLD_MIN = 1; const val HOLD_MAX = 5
        const val REPEAT_MIN = 500L; const val REPEAT_MAX = 5000L

        /** What the scanners did before calibration: a strip across the middle for labels, a centred square for QR. */
        fun default(kind: ScanKind): ScanTuning = when (kind) {
            ScanKind.Labels -> ScanTuning(ScanArea(0.08f, 0.37f, 0.92f, 0.63f))
            ScanKind.Qr -> ScanTuning(ScanArea(0.21f, 0.125f, 0.79f, 0.875f))
        }
    }
}

/**
 * Decides which reads become scans. Each analysed frame passes the codes inside the area (the preferred one first); a code is passed
 * on once it has been read [ScanTuning.hold] frames in a row, and the same code not again within [ScanTuning.repeatMs].
 */
class ScanGate(private val tuning: () -> ScanTuning, private val nowMs: () -> Long = System::currentTimeMillis) {
    private var streakOf: String? = null
    private var streak = 0
    private var lastOf: String? = null
    private var lastAt = 0L

    fun onFrame(codes: List<String>): String? {
        val v = codes.firstOrNull()
        if (v == null) { streakOf = null; streak = 0; return null }
        if (v == streakOf) streak++ else { streakOf = v; streak = 1 }
        val t = tuning()
        if (streak < t.hold) return null
        val now = nowMs()
        if (v == lastOf && now - lastAt < t.repeatMs) return null
        lastOf = v; lastAt = now
        return v
    }
}

/** The saved tuning per [ScanKind]; Settings > Scanner edits it and every viewfinder reads it. */
interface ScannerPrefs {
    fun tuning(kind: ScanKind): Flow<ScanTuning>
    suspend fun set(kind: ScanKind, tuning: ScanTuning)
}

private val Context.scannerStore: DataStore<Preferences> by preferencesDataStore(name = "scanner")

class DataStoreScannerPrefs(private val context: Context) : ScannerPrefs {
    private fun key(kind: ScanKind) = stringPreferencesKey(kind.key)

    override fun tuning(kind: ScanKind): Flow<ScanTuning> = context.scannerStore.data.map { p ->
        p[key(kind)]?.let { runCatching { LinkpearlJson.decodeFromString(ScanTuning.serializer(), it).clamped() }.getOrNull() } ?: ScanTuning.default(kind)
    }

    override suspend fun set(kind: ScanKind, tuning: ScanTuning) {
        context.scannerStore.edit { it[key(kind)] = LinkpearlJson.encodeToString(ScanTuning.serializer(), tuning.clamped()) }
    }
}

/** In memory, for tests and previews. */
class MemoryScannerPrefs(initial: Map<ScanKind, ScanTuning> = emptyMap()) : ScannerPrefs {
    private val all = MutableStateFlow(ScanKind.entries.associateWith { initial[it] ?: ScanTuning.default(it) })
    override fun tuning(kind: ScanKind): Flow<ScanTuning> = all.map { it.getValue(kind) }
    override suspend fun set(kind: ScanKind, tuning: ScanTuning) = all.update { it + (kind to tuning.clamped()) }
}
