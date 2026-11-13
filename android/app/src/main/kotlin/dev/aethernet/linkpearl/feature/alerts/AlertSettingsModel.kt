package dev.aethernet.linkpearl.feature.alerts

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import java.time.DateTimeException
import java.time.LocalTime

/** A type's switch and its single threshold: days (stuck, pickup), the hour of day (followup), hours (quiet). */
data class TypeSetting(val on: Boolean, val value: Int)

data class QuietHours(val on: Boolean, val from: String, val to: String)

data class AlertSettings(
    val types: Map<AlertType, TypeSetting>,
    val quiet: QuietHours,
    /** Per-store switches by store id. */
    val stores: Map<Int, Boolean>,
)

/** Server ranges (inclusive). */
data class Ranges(val stuckDays: IntRange, val pickupDays: IntRange, val quietHours: IntRange, val followupHour: IntRange) {
    fun of(type: AlertType): IntRange = when (type) {
        AlertType.Stuck -> stuckDays
        AlertType.Pickup -> pickupDays
        AlertType.Followup -> followupHour
        AlertType.Quiet -> quietHours
        AlertType.Back -> 0..0
    }

    companion object {
        val Default = Ranges(1..30, 1..30, 1..12, 0..23)
    }
}

data class SettingsBundle(val settings: AlertSettings, val ranges: Ranges, val storeIds: List<Int>)

private fun JsonObject.obj(k: String) = this[k] as? JsonObject
private fun JsonObject.int(k: String) = (this[k] as? JsonPrimitive)?.intOrNull
private fun JsonObject.bool(k: String) = (this[k] as? JsonPrimitive)?.booleanOrNull
private fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

private fun range(o: JsonObject?, k: String, d: IntRange): IntRange {
    val a = (o?.get(k) as? kotlinx.serialization.json.JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.intOrNull }
    return if (a != null && a.size == 2) a[0]..a[1] else d
}

fun parseSettings(o: JsonObject): SettingsBundle? {
    val s = o.obj("settings") ?: return null
    val t = s.obj("types") ?: return null
    fun type(type: AlertType, key: String): TypeSetting? {
        val x = t.obj(type.key) ?: return null
        return TypeSetting(x.bool("on") ?: true, x.int(key) ?: return null)
    }
    val types = mapOf(
        AlertType.Stuck to (type(AlertType.Stuck, "days") ?: return null),
        AlertType.Pickup to (type(AlertType.Pickup, "days") ?: return null),
        AlertType.Followup to (type(AlertType.Followup, "hour") ?: return null),
        AlertType.Quiet to (type(AlertType.Quiet, "hours") ?: return null),
    )
    val q = s.obj("quietHours") ?: return null
    val quiet = QuietHours(q.bool("on") ?: true, q.str("from") ?: return null, q.str("to") ?: return null)
    val stores = s.obj("stores")?.mapNotNull { (k, v) -> k.toIntOrNull()?.let { id -> id to ((v as? JsonPrimitive)?.booleanOrNull ?: true) } }?.toMap() ?: emptyMap()
    val ids = (o["stores"] as? kotlinx.serialization.json.JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.intOrNull } ?: stores.keys.toList()
    val r = o.obj("ranges")
    val ranges = Ranges(range(r, "stuckDays", Ranges.Default.stuckDays), range(r, "pickupDays", Ranges.Default.pickupDays),
        range(r, "quietHours", Ranges.Default.quietHours), range(r, "followupHour", Ranges.Default.followupHour))
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
            val key = when (type) { AlertType.Followup -> "hour"; AlertType.Quiet -> "hours"; else -> "days" }
            put("types", buildJsonObject { put(type.key, buildJsonObject { put(key, value) }) })
        }
        override fun inverse(s: AlertSettings) = TypeValue(type, s.types[type]?.value ?: value)
        override fun problem(s: AlertSettings, r: Ranges) = if (type.configurable && value in r.of(type)) null else "Out of range"
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
