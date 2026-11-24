package dev.aethernet.linkpearl.feature.alerts

import dev.aethernet.linkpearl.core.data.boolOrNull
import dev.aethernet.linkpearl.core.data.intOrNull
import dev.aethernet.linkpearl.core.data.jsonStrOrNull
import dev.aethernet.linkpearl.core.data.objOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import java.time.DateTimeException
import java.time.LocalTime

/**
 * A type's switch and its single threshold: days (stuck, pickup), the hour of day (followup, digest), hours (quiet, unlinked).
 * Coverage has a switch only; its value is 0 and never shown or sent.
 */
data class TypeSetting(val on: Boolean, val value: Int = 0)

/** The JSON key of a type's threshold (null: no threshold). */
fun AlertType.valueKey(): String? = when (this) {
    AlertType.Stuck, AlertType.Pickup -> "days"
    AlertType.Followup, AlertType.Digest -> "hour"
    AlertType.Quiet, AlertType.Unlinked -> "hours"
    AlertType.Coverage, AlertType.Back -> null
}

data class QuietHours(val on: Boolean, val from: String, val to: String)

data class AlertSettings(
    val types: Map<AlertType, TypeSetting>,
    val quiet: QuietHours,
    /** Per-store switches by store id. */
    val stores: Map<Int, Boolean>,
)

/** Server ranges (inclusive). */
data class Ranges(
    val stuckDays: IntRange,
    val pickupDays: IntRange,
    val quietHours: IntRange,
    val followupHour: IntRange,
    val digestHour: IntRange = 0..23,
    val unlinkedHours: IntRange = 1..48,
) {
    fun of(type: AlertType): IntRange = when (type) {
        AlertType.Stuck -> stuckDays
        AlertType.Pickup -> pickupDays
        AlertType.Followup -> followupHour
        AlertType.Quiet -> quietHours
        AlertType.Digest -> digestHour
        AlertType.Unlinked -> unlinkedHours
        AlertType.Coverage, AlertType.Back -> 0..0
    }

    companion object {
        val Default = Ranges(1..30, 1..30, 1..12, 0..23, 0..23, 1..48)
    }
}

data class SettingsBundle(val settings: AlertSettings, val ranges: Ranges, val storeIds: List<Int>)


private fun range(o: JsonObject?, k: String, d: IntRange): IntRange {
    val a = (o?.get(k) as? kotlinx.serialization.json.JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.intOrNull }
    return if (a != null && a.size == 2) a[0]..a[1] else d
}

fun parseSettings(o: JsonObject): SettingsBundle? {
    val s = o.objOrNull("settings") ?: return null
    val t = s.objOrNull("types") ?: return null
    fun type(type: AlertType, key: String): TypeSetting? {
        val x = t.objOrNull(type.key) ?: return null
        return TypeSetting(x.boolOrNull("on") ?: true, x.intOrNull(key) ?: return null)
    }
    val types = buildMap {
        put(AlertType.Stuck, type(AlertType.Stuck, "days") ?: return null)
        put(AlertType.Pickup, type(AlertType.Pickup, "days") ?: return null)
        put(AlertType.Followup, type(AlertType.Followup, "hour") ?: return null)
        put(AlertType.Quiet, type(AlertType.Quiet, "hours") ?: return null)
        // Newer types: optional (a server without them simply has no row for them).
        type(AlertType.Digest, "hour")?.let { put(AlertType.Digest, it) }
        type(AlertType.Unlinked, "hours")?.let { put(AlertType.Unlinked, it) }
        t.objOrNull(AlertType.Coverage.key)?.let { put(AlertType.Coverage, TypeSetting(it.boolOrNull("on") ?: true)) }
    }
    val q = s.objOrNull("quietHours") ?: return null
    val quiet = QuietHours(q.boolOrNull("on") ?: true, q.jsonStrOrNull("from") ?: return null, q.jsonStrOrNull("to") ?: return null)
    val stores = s.objOrNull("stores")?.mapNotNull { (k, v) -> k.toIntOrNull()?.let { id -> id to ((v as? JsonPrimitive)?.booleanOrNull ?: true) } }?.toMap() ?: emptyMap()
    val ids = (o["stores"] as? kotlinx.serialization.json.JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.intOrNull } ?: stores.keys.toList()
    val r = o.objOrNull("ranges")
    val ranges = Ranges(range(r, "stuckDays", Ranges.Default.stuckDays), range(r, "pickupDays", Ranges.Default.pickupDays),
        range(r, "quietHours", Ranges.Default.quietHours), range(r, "followupHour", Ranges.Default.followupHour),
        range(r, "digestHour", Ranges.Default.digestHour), range(r, "unlinkedHours", Ranges.Default.unlinkedHours))
    return SettingsBundle(AlertSettings(types, quiet, stores), ranges, ids)
}

/** "HH:MM" 24-hour, as the server wants it. */
fun isHhmm(s: String): Boolean = Regex("^([01]\\d|2[0-3]):[0-5]\\d$").matches(s)

fun toHhmm(hour: Int, minute: Int): String = "%02d:%02d".format(hour, minute)

fun hhmmParts(s: String): Pair<Int, Int> = try { LocalTime.parse(s).let { it.hour to it.minute } } catch (_: DateTimeException) { 0 to 0 }

/** One change the owner makes. Applied optimistically, sent as a partial PUT, undone through [inverse] when the server refuses. */
sealed interface SettingsEdit {
    fun apply(s: AlertSettings): AlertSettings
    fun json(): JsonObject
    /** The edit that restores what [s] holds now. */
    fun inverse(s: AlertSettings): SettingsEdit
    /** Null when acceptable, else the reason (checked before anything goes out). */
    fun problem(s: AlertSettings, r: Ranges): String?

    data class TypeOn(val type: AlertType, val on: Boolean) : SettingsEdit {
        override fun apply(s: AlertSettings): AlertSettings = s.copy(types = s.types + (type to (s.types[type] ?: return s).copy(on = on)))
        override fun json() = buildJsonObject { put("types", buildJsonObject { put(type.key, buildJsonObject { put("on", on) }) }) }
        override fun inverse(s: AlertSettings) = TypeOn(type, s.types[type]?.on ?: on)
        override fun problem(s: AlertSettings, r: Ranges) = if (type.configurable) null else "Not configurable"
    }

    data class TypeValue(val type: AlertType, val value: Int) : SettingsEdit {
        override fun apply(s: AlertSettings): AlertSettings = s.copy(types = s.types + (type to (s.types[type] ?: return s).copy(value = value)))
        override fun json() = buildJsonObject {
            val key = type.valueKey() ?: "days" // never sent: problem() refuses a type without a threshold
            put("types", buildJsonObject { put(type.key, buildJsonObject { put(key, value) }) })
        }
        override fun inverse(s: AlertSettings) = TypeValue(type, s.types[type]?.value ?: value)
        override fun problem(s: AlertSettings, r: Ranges) = when {
            !type.hasThreshold -> "Not configurable"
            value in r.of(type) -> null
            else -> "Out of range"
        }
    }

    data class QuietOn(val on: Boolean) : SettingsEdit {
        override fun apply(s: AlertSettings): AlertSettings = s.copy(quiet = s.quiet.copy(on = on))
        override fun json() = buildJsonObject { put("quietHours", buildJsonObject { put("on", on) }) }
        override fun inverse(s: AlertSettings) = QuietOn(s.quiet.on)
        override fun problem(s: AlertSettings, r: Ranges): String? = null
    }

    data class QuietFrom(val hhmm: String) : SettingsEdit {
        override fun apply(s: AlertSettings): AlertSettings = s.copy(quiet = s.quiet.copy(from = hhmm))
        override fun json() = buildJsonObject { put("quietHours", buildJsonObject { put("from", hhmm) }) }
        override fun inverse(s: AlertSettings) = QuietFrom(s.quiet.from)
        override fun problem(s: AlertSettings, r: Ranges) = if (!isHhmm(hhmm)) "Not a time" else if (hhmm == s.quiet.to) "From and to must differ" else null
    }

    data class QuietTo(val hhmm: String) : SettingsEdit {
        override fun apply(s: AlertSettings): AlertSettings = s.copy(quiet = s.quiet.copy(to = hhmm))
        override fun json() = buildJsonObject { put("quietHours", buildJsonObject { put("to", hhmm) }) }
        override fun inverse(s: AlertSettings) = QuietTo(s.quiet.to)
        override fun problem(s: AlertSettings, r: Ranges) = if (!isHhmm(hhmm)) "Not a time" else if (hhmm == s.quiet.from) "From and to must differ" else null
    }

    data class StoreOn(val store: Int, val on: Boolean) : SettingsEdit {
        override fun apply(s: AlertSettings): AlertSettings = s.copy(stores = s.stores + (store to on))
        override fun json() = buildJsonObject { put("stores", buildJsonObject { put(store.toString(), on) }) }
        override fun inverse(s: AlertSettings) = StoreOn(store, s.stores[store] ?: true)
        override fun problem(s: AlertSettings, r: Ranges): String? = null
    }
}
