package dev.aethernet.linkpearl.core.data

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import java.time.DateTimeException
import java.time.ZoneId

/**
 * The stores' time zone, as Home reports it (`tz`). Home writes it on every answer and it is kept with the session, so Work orders,
 * Alerts and Settings can format times in the store's zone (not the phone's) without asking again. Until Home has answered once the
 * fallback is the zone the server uses today.
 */
class StoreZone(private val session: SessionStore) {
    val id: String get() = valid(session.current.tz) ?: FALLBACK
    val zone: ZoneId get() = ZoneId.of(id)
    val ids: Flow<String> get() = session.flow.map { valid(it.tz) ?: FALLBACK }.distinctUntilChanged()

    fun remember(tz: String?) {
        val ok = valid(tz) ?: return
        // Only a registered phone keeps it (a forgotten session must stay empty).
        if (session.current.status == "active" && session.current.tz != ok) session.update { it.copy(tz = ok) }
    }

    companion object {
        const val FALLBACK = "America/New_York"
        fun valid(tz: String?): String? = tz?.takeIf { it.isNotBlank() }?.takeIf { try { ZoneId.of(it); true } catch (_: DateTimeException) { false } }
    }
}
