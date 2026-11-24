package dev.aethernet.linkpearl.feature.buybacks

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

/** The buybacks Aethernet's "Scan with phone" sent from a buyback order's "Add buyback parts" popout. */
data class BbRun(val run: String, val order: String, val store: String, val items: List<BbItem>) {
    val total get() = items.size
    val added get() = items.count { it.state == BbState.Added }
}
data class BbItem(val i: Int, val label: String, val destination: String, val state: BbState)

enum class BbState(val wire: String) {
    Pending("pending"), Added("added"), Failed("failed");
    companion object { fun of(s: String?) = entries.firstOrNull { it.wire == s } ?: Pending }
}

/** The browser's answer to a scan: [i] = -1 for a label that isn't in the list; [message] = Portal's error (or the browser's) on a failure. */
data class BbResult(val run: String, val label: String, val i: Int, val state: BbState, val message: String?)

object Buybacks {
    /** Buyback labels only: `B-<item>-<digits>`. */
    fun isLabel(v: String) = Regex("^B-\\S+$", RegexOption.IGNORE_CASE).matches(v.trim())
    /** The short destination: the part in parentheses ("Asurion Reverse Logistics (TLC)" → "TLC"), else the whole. */
    fun shortDestination(d: String) = Regex("\\(([^)]+)\\)\\s*$").find(d)?.groupValues?.get(1)?.trim() ?: d.trim()
}

/**
 * Buyback scans over Linkshell, the phone's half (the browser's is in src/45-buybacks.js, which lists the messages). Holds the run on
 * offer (the Linkshell screen shows it with Join) and passes the browser's answers to the Buybacks screen.
 */
class BuybackLink(private val ls: LinkshellClient) {
    private val _offer = MutableStateFlow<BbRun?>(null)
    /** The browser's latest run, complete and kept up to date with its results; null when there is none or it ended. */
    val offer: StateFlow<BbRun?> = _offer.asStateFlow()
    private val _results = MutableSharedFlow<BbResult>(extraBufferCapacity = 256)
    val results: SharedFlow<BbResult> = _results.asSharedFlow()
    private val _ended = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val ended: SharedFlow<String> = _ended.asSharedFlow()
    val state get() = ls.state

    private var joining: BbRun? = null
    private var parts: Pair<String, MutableMap<Int, List<BbItem>>>? = null
    private var meta: Triple<String, String, Int>? = null // order, store, parts

    init {
        ls.on("buybacks.run", ::onRun)
        ls.on("buybacks.result") { m ->
            val b = m.body
            val r = BbResult(b.str("run"), b.str("label"), (b["i"] as? JsonPrimitive)?.intOrNull ?: -1, BbState.of(b.str("state")),
                (b["message"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() })
            _offer.value?.takeIf { it.run == r.run && r.i >= 0 }?.let { o -> _offer.value = o.copy(items = o.items.map { if (it.i == r.i) it.copy(state = r.state) else it }) }
            _results.tryEmit(r)
        }
        ls.on("buybacks.end") { m ->
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
        if (parts?.first != run || meta?.third != count) { parts = run to mutableMapOf(); meta = Triple(b.str("order"), b.str("store"), count) }
        val rows = (b["items"] as? JsonArray).orEmpty().mapNotNull { row ->
            val r = row as? JsonArray ?: return@mapNotNull null
            fun s(k: Int) = (r.getOrNull(k) as? JsonPrimitive)?.contentOrNull.orEmpty()
            val i = (r.getOrNull(0) as? JsonPrimitive)?.intOrNull ?: return@mapNotNull null
            BbItem(i, s(1), s(2), BbState.of(s(3)))
        }
        val got = parts!!.second.apply { put(part, rows) }
        if (got.size == count) {
            val (order, store, _) = meta!!
            _offer.value = BbRun(run, order, store, (0 until count).flatMap { got[it].orEmpty() }.sortedBy { it.i })
        }
    }

    /** Join from the Linkshell screen: Buybacks takes it once. */
    fun join(run: BbRun) { joining = run }
    fun takeJoin(): BbRun? = joining.also { joining = null }

    fun wake() = ls.wake()
    fun scan(run: String, label: String) = ls.send("buybacks.scan", buildJsonObject { put("run", run); put("label", label) })
    /** Ask the browser for the list again. */
    fun rejoin(run: String) = ls.send("buybacks.join", buildJsonObject { put("run", run) })
}
