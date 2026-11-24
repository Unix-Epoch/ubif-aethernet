package dev.aethernet.linkpearl.feature.morningcheck

import dev.aethernet.linkpearl.feature.linkshell.LinkshellClient
import dev.aethernet.linkpearl.feature.linkshell.LsMessage
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/** One open work order as the browser listed it. */
data class McRow(
    val wo: String, val statusId: Int, val bin: String, val nickname: String,
    val device: String, val issue: String, val customer: String, val program: String, val updatedAt: String,
)

/** A Portal status: its name, and the statuses the phone may move it to (the browser decides: proven calls only). */
data class McStatus(val id: Int, val name: String, val moves: List<Int>)

/** The browser's list for a check. [bins]: whether bin changes are on. */
data class McList(val run: String, val store: String, val rows: List<McRow>, val statuses: Map<Int, McStatus>, val bins: Boolean)

/** What Portal took for one change set. [failed]: field → Portal's message. [row]: the order after, when the browser could read it. */
data class McResult(val run: String, val cid: String, val wo: String, val ok: Boolean, val failed: List<Pair<String, String>>, val after: McAfter?)
data class McAfter(val statusId: Int, val bin: String, val nickname: String, val updatedAt: String)

/** One work order's changes; null = unchanged. */
data class McChange(val status: Int? = null, val bin: String? = null, val nickname: String? = null, val note: String? = null) {
    val empty get() = status == null && bin == null && nickname == null && note.isNullOrBlank()
}

/**
 * Morning check over Linkshell, the phone's half (the browser's is in src/68-morning-check.js, which lists the messages).
 * The browser acts only while its Morning check panel is open: a PC asks there first, a host link starts by itself.
 */
class MorningCheckLink(private val ls: LinkshellClient) {
    private val _list = MutableStateFlow<McList?>(null)
    val list: StateFlow<McList?> = _list.asStateFlow()
    private val _results = MutableSharedFlow<McResult>(extraBufferCapacity = 64)
    val results: SharedFlow<McResult> = _results.asSharedFlow()
    private val _ended = MutableSharedFlow<Pair<String, String>>(extraBufferCapacity = 8)
    /** (run, reason): "declined", "stopped", "failed". */
    val ended: SharedFlow<Pair<String, String>> = _ended.asSharedFlow()
    val state get() = ls.state
    /** The check in progress, kept here so leaving the screen doesn't lose it. */
    var saved: McSession? = null

    private var parts: Triple<String, Int, MutableMap<Int, List<McRow>>>? = null
    private var head: Triple<String, Boolean, Map<Int, McStatus>>? = null

    init {
        ls.on("check.list", ::onList)
        ls.on("check.result") { m -> parseResult(m.body)?.let { _results.tryEmit(it) } }
        ls.on("check.end") { m -> _ended.tryEmit(m.body.str("run") to m.body.str("reason").ifEmpty { "stopped" }) }
    }

    private fun onList(m: LsMessage) {
        val b = m.body
        val run = b.str("run").ifEmpty { return }
        val part = b.int("part") ?: return
        val count = b.int("parts")?.takeIf { it in 1..1000 } ?: return
        if (parts?.first != run || parts?.second != count) { parts = Triple(run, count, mutableMapOf()); head = null }
        if (part == 0) head = Triple(b.str("store"), (b["bins"] as? JsonPrimitive)?.booleanOrNull == true, parseStatuses(b["statuses"]))
        val got = parts!!.third.apply { put(part, parseRows(b["rows"])) }
        val h = head
        if (got.size == count && h != null) _list.value = McList(run, h.first, (0 until count).flatMap { got[it].orEmpty() }, h.third, h.second)
    }

    fun start(run: String) {
        if (_list.value?.run != run) _list.value = null
        ls.send("check.start", buildJsonObject { put("run", run) })
        ls.wake()
    }
    fun set(run: String, cid: String, row: McRow, c: McChange) = ls.send("check.set", buildJsonObject {
        put("run", run); put("cid", cid); put("wo", row.wo); put("updatedAt", row.updatedAt)
        c.status?.let { put("status", it) }
        c.bin?.let { put("bin", it) }
        c.nickname?.let { put("nickname", it) }
        c.note?.takeIf { it.isNotBlank() }?.let { put("note", it.trim()) }
    })
    fun progress(run: String, done: Int, total: Int) = ls.send("check.progress", buildJsonObject { put("run", run); put("done", done); put("total", total) })
    fun end(run: String) { ls.send("check.end", buildJsonObject { put("run", run) }); if (_list.value?.run == run) _list.value = null }
    fun wake() = ls.wake()

    companion object {
        private fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.contentOrNull.orEmpty()
        private fun JsonObject.int(k: String) = (this[k] as? JsonPrimitive)?.intOrNull
        private fun JsonElement?.s() = (this as? JsonPrimitive)?.contentOrNull.orEmpty()
        private fun JsonElement?.i() = (this as? JsonPrimitive)?.intOrNull

        fun parseRows(e: JsonElement?): List<McRow> = (e as? JsonArray).orEmpty().mapNotNull { row ->
            val r = row as? JsonArray ?: return@mapNotNull null
            val wo = r.getOrNull(0).s().takeIf { it.matches(Regex("""\d{1,12}""")) } ?: return@mapNotNull null
            McRow(wo, r.getOrNull(1).i() ?: return@mapNotNull null, r.getOrNull(2).s(), r.getOrNull(3).s(), r.getOrNull(4).s(), r.getOrNull(5).s(),
                r.getOrNull(6).s(), r.getOrNull(7).s(), r.getOrNull(8).s())
        }

        fun parseStatuses(e: JsonElement?): Map<Int, McStatus> = (e as? JsonArray).orEmpty().mapNotNull { row ->
            val r = row as? JsonArray ?: return@mapNotNull null
            val id = r.getOrNull(0).i() ?: return@mapNotNull null
            McStatus(id, r.getOrNull(1).s(), (r.getOrNull(2) as? JsonArray).orEmpty().mapNotNull { it.i() })
        }.associateBy { it.id }

        fun parseResult(b: JsonObject): McResult? {
            val after = (b["row"] as? JsonArray)?.let { r -> r.getOrNull(1).i()?.let { McAfter(it, r.getOrNull(2).s(), r.getOrNull(3).s(), r.getOrNull(4).s()) } }
            val failed = (b["failed"] as? JsonArray).orEmpty().mapNotNull { f -> (f as? JsonArray)?.let { it.getOrNull(0).s() to it.getOrNull(1).s() } }
            return McResult(b.str("run"), b.str("cid").ifEmpty { return null }, b.str("wo"), (b["ok"] as? JsonPrimitive)?.booleanOrNull == true, failed, after)
        }
    }
}
