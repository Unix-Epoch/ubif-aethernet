package dev.aethernet.linkpearl.feature.linkshell

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/**
 * Puts a list back together that the browser sent in parts. Every part's message carries `run`, `part` (from 0) and `parts`
 * (how many, 1 to 1000) next to its rows. Parts may arrive in any order; a part of another run, or with another part count, starts over.
 */
class Parts<T> {
    /** What a part's message says about itself. */
    data class Header(val run: String, val part: Int, val count: Int)

    private var run: String? = null
    private var count = 0
    private val got = mutableMapOf<Int, List<T>>()

    /** Keeps one part's [rows]. True when it started a new list (whatever was kept of another one is dropped). */
    fun add(h: Header, rows: List<T>): Boolean {
        val fresh = run != h.run || count != h.count
        if (fresh) { run = h.run; count = h.count; got.clear() }
        got[h.part] = rows
        return fresh
    }

    /** Every row, in part order, once all the parts are here; null until then. */
    fun complete(): List<T>? = if (run != null && got.size == count) (0 until count).flatMap { got[it].orEmpty() } else null

    fun clear() { run = null; count = 0; got.clear() }

    companion object {
        /** Null when [body] isn't a part: no run, no part number, or a part count outside 1..1000. */
        fun header(body: JsonObject): Header? {
            val run = (body["run"] as? JsonPrimitive)?.contentOrNull.orEmpty().ifEmpty { return null }
            val part = (body["part"] as? JsonPrimitive)?.intOrNull ?: return null
            val count = (body["parts"] as? JsonPrimitive)?.intOrNull?.takeIf { it in 1..1000 } ?: return null
            return Header(run, part, count)
        }
    }
}
