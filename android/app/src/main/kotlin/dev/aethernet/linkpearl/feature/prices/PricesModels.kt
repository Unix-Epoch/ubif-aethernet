package dev.aethernet.linkpearl.feature.prices

import dev.aethernet.linkpearl.core.design.Fmt
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.Locale

/**
 * The Prices answers (`tracker-worker/MOBILE-API-prices.md`), read by hand so every field is optional: an unknown key is ignored, a missing
 * or mistyped one is null (a number sent as text still reads). A change in the server's shape is a change in this file only.
 */
data class PriceDevice(val key: String?, val name: String, val tab: String?)

data class PriceDevices(val store: Int?, val syncedAt: String?, val devices: List<PriceDevice>)

data class PriceRepair(val repair: String?, val label: String?, val price: Double?, val raw: String?) {
    /** The row's words: the sheet column (`label`), else the repair type. */
    val title: String get() = label?.takeIf { it.isNotBlank() } ?: repair?.takeIf { it.isNotBlank() } ?: Fmt.DASH

    /** The price, else the cell's own words when they say something ("Apple self repair"), else a dash. */
    val shown: String get() = price?.let(PriceFmt::money) ?: raw?.trim()?.takeIf { PriceFmt.meaningful(it) } ?: Fmt.DASH
}

/** [variant] = "inner", "outer" or null (a Fold answers with both halves). */
data class PriceMatch(val name: String, val tab: String?, val variant: String?, val repairs: List<PriceRepair>) {
    /** "Galaxy Z Fold 5 · Inner" for a Fold half, else the row's name. */
    val chipLabel: String get() {
        val v = variant?.takeIf { it.isNotBlank() }?.replaceFirstChar { it.titlecase(Locale.US) } ?: return name
        val base = name.removeSuffix(" $v").removeSuffix(" ${v.lowercase()}").trim()
        return base + Fmt.DOT.trimEnd() + " " + v
    }
}

data class PriceMatches(val store: Int?, val syncedAt: String?, val matches: List<PriceMatch>)

object PriceParse {
    private fun JsonElement?.obj(): JsonObject? = this as? JsonObject
    private fun JsonElement?.arr(): List<JsonElement> = (this as? JsonArray).orEmpty()
    private fun JsonElement?.str(): String? = (this as? JsonPrimitive)?.takeIf { this !is JsonNull }?.content?.takeIf { it.isNotEmpty() }
    private fun JsonElement?.num(): Double? = (this as? JsonPrimitive)?.takeIf { this !is JsonNull }?.content?.trim()?.removePrefix("$")?.replace(",", "")?.toDoubleOrNull()

    fun devices(json: JsonElement): PriceDevices {
        val o = json.obj() ?: return PriceDevices(null, null, emptyList())
        val list = o["devices"].arr().mapNotNull { e ->
            val d = e.obj() ?: return@mapNotNull null
            val name = d["name"].str() ?: d["key"].str() ?: return@mapNotNull null
            PriceDevice(d["key"].str(), name, d["tab"].str())
        }
        return PriceDevices(o["store"].num()?.toInt(), o["syncedAt"].str(), list)
    }

    fun matches(json: JsonElement): PriceMatches {
        val o = json.obj() ?: return PriceMatches(null, null, emptyList())
        val list = o["matches"].arr().mapNotNull { e ->
            val m = e.obj() ?: return@mapNotNull null
            val repairs = m["repairs"].arr().mapNotNull { r ->
                val x = r.obj() ?: return@mapNotNull null
                PriceRepair(x["repair"].str(), x["label"].str(), x["price"].num(), x["raw"].str())
            }
            PriceMatch(m["name"].str() ?: Fmt.DASH, m["tab"].str(), m["variant"].str(), repairs)
        }
        return PriceMatches(o["store"].num()?.toInt(), o["syncedAt"].str(), list)
    }
}

object PriceFmt {
    /** "$329.99", "$190" (cents only when there are some). */
    fun money(v: Double): String {
        val cents = Math.round(v * 100)
        return if (cents % 100 == 0L) "$" + String.format(Locale.US, "%,d", cents / 100) else "$" + String.format(Locale.US, "%,.2f", cents / 100.0)
    }

    /** A cell's text worth showing instead of a dash: not blank, not "N/A" / "NA" / "-". */
    fun meaningful(raw: String): Boolean {
        val t = raw.trim().lowercase(Locale.US)
        return t.isNotEmpty() && t !in setOf("n/a", "na", "-", "–", "—", "none", "null")
    }

    /**
     * The devices for what is typed: every word must appear in the name (or the run-together key), shortest names first so the plain
     * model comes before its longer siblings ("15 pro": iPhone 15 Pro, then iPhone 15 Pro Max).
     */
    fun filter(devices: List<PriceDevice>, query: String, limit: Int = 8): List<PriceDevice> {
        val words = query.lowercase(Locale.US).split(Regex("\\s+")).filter { it.isNotBlank() }
        if (words.isEmpty()) return emptyList()
        return devices.filter { d ->
            val name = d.name.lowercase(Locale.US).replace("+", " plus")
            val key = d.key?.lowercase(Locale.US) ?: ""
            words.all { w -> name.contains(w) || key.contains(w) }
        }.distinctBy { it.key ?: it.name }.sortedBy { it.name.length }.take(limit)
    }

    /** What the Share button sends: the device, then "Repair: price" lines. */
    fun shareText(matches: List<PriceMatch>): String = matches.joinToString("\n\n") { m ->
        (listOf(m.chipLabel) + m.repairs.map { "${it.title}: ${it.shown}" }).joinToString("\n")
    }
}
