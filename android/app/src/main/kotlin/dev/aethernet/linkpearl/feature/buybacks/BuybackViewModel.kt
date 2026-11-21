package dev.aethernet.linkpearl.feature.buybacks

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** A label scanned on this phone: Sending until the browser answers, then its answer. */
data class BbScan(val label: String, val destination: String, val state: BbScanState, val message: String? = null)
enum class BbScanState { Sending, Added, Failed }

sealed interface BbUi {
    /** No run from the PC (opened without Join, or the PC stopped it). */
    data class None(val stopped: Boolean = false) : BbUi
    /** [scans]: newest first. [pc]: the browser is connected. [notLabel]: the last typed code wasn't a B- label. */
    data class Scanning(val run: BbRun, val scans: List<BbScan>, val pc: Boolean, val notLabel: String? = null) : BbUi {
        val last get() = scans.firstOrNull()
        val sending get() = scans.count { it.state == BbScanState.Sending }
        /** The list's labels nobody has scanned or added yet. */
        val toScan get() = run.items.filter { it.state == BbState.Pending && scans.none { s -> s.label.equals(it.label, true) } }
    }
}

class BuybackViewModel(private val link: BuybackLink) : ViewModel() {
    private val _state = MutableStateFlow<BbUi>(BbUi.None())
    val state: StateFlow<BbUi> = _state.asStateFlow()

    init {
        link.wake()
        (link.takeJoin() ?: link.offer.value)?.let { _state.value = BbUi.Scanning(it, emptyList(), link.state.value.peer) }
        viewModelScope.launch { link.state.collect { s -> scanning { it.copy(pc = s.peer) } } }
        viewModelScope.launch { link.offer.collect { o -> if (o != null) scanning { if (it.run.run == o.run) it.copy(run = o) else it } } }
        viewModelScope.launch { link.ended.collect { run -> if ((_state.value as? BbUi.Scanning)?.run?.run == run) _state.value = BbUi.None(stopped = true) } }
        viewModelScope.launch {
            link.results.collect { r ->
                scanning { s ->
                    if (s.run.run != r.run) return@scanning s
                    val st = if (r.state == BbState.Added) BbScanState.Added else BbScanState.Failed
                    val hit = s.scans.indexOfFirst { it.label.equals(r.label, true) }
                    val scans = if (hit < 0) listOf(BbScan(r.label, destOf(s.run, r.label), st, r.message)) + s.scans
                    else s.scans.mapIndexed { k, it -> if (k == hit) it.copy(state = st, message = r.message) else it }
                    s.copy(scans = scans)
                }
            }
        }
    }

    private inline fun scanning(f: (BbUi.Scanning) -> BbUi.Scanning) = _state.update { (it as? BbUi.Scanning)?.let(f) ?: it }
    private fun destOf(run: BbRun, label: String) = run.items.firstOrNull { it.label.equals(label, true) }?.destination.orEmpty()

    /** A code from the camera ([typed] = false: anything but a B- label is ignored) or typed. A label already sent or added is not sent again. */
    fun onCode(raw: String, typed: Boolean = false) {
        val s = _state.value as? BbUi.Scanning ?: return
        val v = raw.trim()
        if (v.isEmpty()) return
        if (!Buybacks.isLabel(v)) { if (typed) _state.value = s.copy(notLabel = v); return }
        val label = s.run.items.firstOrNull { it.label.equals(v, true) }?.label ?: v.uppercase()
        val prev = s.scans.firstOrNull { it.label.equals(label, true) }
        if (prev != null && prev.state != BbScanState.Failed) return
        if (s.run.items.any { it.label.equals(label, true) && it.state == BbState.Added }) return
        _state.value = s.copy(notLabel = null, scans = listOf(BbScan(label, destOf(s.run, label), BbScanState.Sending)) + s.scans.filterNot { it.label.equals(label, true) })
        link.scan(s.run.run, label)
    }
}
