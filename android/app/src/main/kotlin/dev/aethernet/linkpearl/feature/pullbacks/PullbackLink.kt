package dev.aethernet.linkpearl.feature.pullbacks

import dev.aethernet.linkpearl.feature.linkshell.LinkshellClient
import dev.aethernet.linkpearl.feature.linkshell.LsMessage
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/** A run Aethernet sent with "Scan with phone": its list, each item's state as the browser has it. */
data class PcRun(val run: String, val file: String, val store: String, val items: List<PcItem>) {
    val total get() = items.size
    val done get() = items.count { it.state != PcState.Pending && it.state != PcState.Skipped }
}
data class PcItem(val i: Int, val sku: String, val description: String, val serial: String, val state: PcState)

/** The browser's word for an item (Aethernet's phoneState). Queued = scanned, kept until Pullbacks is open there to mark it. */
enum class PcState(val wire: String) {
    Pending("pending"), Queued("queued"), Marked("marked"), Already("already"), Failed("failed"), Skipped("skipped");
    companion object { fun of(s: String?) = entries.firstOrNull { it.wire == s } ?: Pending }
}

data class PcResult(val run: String, val i: Int, val state: PcState, val message: String?)

/**
 * Pullbacks over Linkshell, the phone's half (the browser's is in src/66-pullbacks.js, which lists the messages). Holds the run on
 * offer (shown on the Linkshell screen with Join) and passes the browser's answers to the Pullbacks screen.
 */
class PullbackLink(private val ls: LinkshellClient) {
    private val _offer = MutableStateFlow<PcRun?>(null)
    /** The browser's latest run, complete; null when there is none or it ended. */
    val offer: StateFlow<PcRun?> = _offer.asStateFlow()
    private val _results = MutableSharedFlow<PcResult>(extraBufferCapacity = 256)
    val results: SharedFlow<PcResult> = _results.asSharedFlow()
    private val _ended = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val ended: SharedFlow<String> = _ended.asSharedFlow()
    val state get() = ls.state

    private var joining: PcRun? = null
    private var parts: Pair<String, MutableMap<Int, List<PcItem>>>? = null
    private var meta: Triple<String, String, Int>? = null // file, store, parts

    init {
        ls.on("pullbacks.run", ::onRun)
        ls.on("pullbacks.result") { m ->
            val i = (m.body["i"] as? JsonPrimitive)?.intOrNull ?: return@on
            _results.tryEmit(PcResult(m.body.str("run"), i, PcState.of(m.body.str("state")), m.body["message"]?.let { (it as? JsonPrimitive)?.contentOrNull }))
        }
        ls.on("pullbacks.end") { m ->
            val run = m.body.str("run")
            if (_offer.value?.run == run) _offer.value = null
            _ended.tryEmit(run)
        }
    }

    private fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.contentOrNull.orEmpty()

    private fun onRun(m: LsMessage) {
        val b = m.body
        val run = b.str("run").ifEmpty { return }
        val part = (b["part"] as? JsonPrimitive)?.intOrNull ?: return
        val count = (b["parts"] as? JsonPrimitive)?.intOrNull?.takeIf { it in 1..1000 } ?: return
        if (parts?.first != run || meta?.third != count) { parts = run to mutableMapOf(); meta = Triple(b.str("file"), b.str("store"), count) }
        val rows = (b["items"] as? JsonArray).orEmpty().mapNotNull { row ->
            val r = row as? JsonArray ?: return@mapNotNull null
            fun s(k: Int) = (r.getOrNull(k) as? JsonPrimitive)?.contentOrNull.orEmpty()
            val i = (r.getOrNull(0) as? JsonPrimitive)?.intOrNull ?: return@mapNotNull null
            PcItem(i, s(1), s(2), s(3), PcState.of(s(4)))
        }
        val got = parts!!.second.apply { put(part, rows) }
        if (got.size == count) {
            val (file, store, _) = meta!!
            _offer.value = PcRun(run, file, store, (0 until count).flatMap { got[it].orEmpty() }.sortedBy { it.i })
        }
    }

    /** Join from the Linkshell screen: Pullbacks takes it once. */
    fun join(run: PcRun) { joining = run }
    fun takeJoin(): PcRun? = joining.also { joining = null }

    fun wake() = ls.wake()
    fun scan(run: String, i: Int, serial: String, override: Boolean) =
        ls.send("pullbacks.scan", buildJsonObject { put("run", run); put("i", i); put("serial", serial); put("override", override) })
    fun skip(run: String, i: Int) = ls.send("pullbacks.skip", buildJsonObject { put("run", run); put("i", i) })
    fun undo(run: String, i: Int) = ls.send("pullbacks.undo", buildJsonObject { put("run", run); put("i", i) })
    /** Ask the browser for the list again (the phone reopened a run). */
    fun rejoin(run: String) = ls.send("pullbacks.join", buildJsonObject { put("run", run) })
}
