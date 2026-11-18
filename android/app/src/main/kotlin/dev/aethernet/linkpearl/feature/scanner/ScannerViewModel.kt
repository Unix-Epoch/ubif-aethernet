package dev.aethernet.linkpearl.feature.scanner

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Settings > Scanner: which setup is shown, its tuning (live), and the last code read with this tuning and how many reads. */
data class ScannerUi(
    val kind: ScanKind = ScanKind.Labels,
    val tuning: ScanTuning = ScanTuning.default(ScanKind.Labels),
    val lastCode: String? = null,
    val reads: Int = 0,
)

/** Changes apply to the viewfinder at once and are saved shortly after the last one (a drag changes the area many times a second). */
@OptIn(FlowPreview::class)
class ScannerViewModel(private val prefs: ScannerPrefs, private val saveDelayMs: Long = 300) : ViewModel() {
    private val _state = MutableStateFlow(ScannerUi())
    val state: StateFlow<ScannerUi> = _state.asStateFlow()

    private val pending = MutableStateFlow<Pair<ScanKind, ScanTuning>?>(null)
    private var loading: Job? = null

    init {
        load(ScanKind.Labels)
        viewModelScope.launch {
            pending.filterNotNull().debounce(saveDelayMs).collect { (k, t) -> prefs.set(k, t) }
        }
    }

    fun pick(kind: ScanKind) {
        if (kind == _state.value.kind) return
        flush()
        load(kind)
    }

    fun change(tuning: ScanTuning) {
        val t = tuning.clamped()
        _state.update { it.copy(tuning = t) }
        pending.value = _state.value.kind to t
    }

    fun setArea(area: ScanArea) = change(_state.value.tuning.copy(area = area))

    fun reset() = change(ScanTuning.default(_state.value.kind))

    fun onCode(code: String) = _state.update { it.copy(lastCode = code, reads = it.reads + 1) }

    /** Saves a pending change now (leaving the screen or switching setups). */
    fun flush() {
        val p = pending.value ?: return
        pending.value = null
        viewModelScope.launch { prefs.set(p.first, p.second) }
    }

    private fun load(kind: ScanKind) {
        loading?.cancel()
        _state.value = ScannerUi(kind, ScanTuning.default(kind))
        loading = viewModelScope.launch {
            val t = prefs.tuning(kind).first()
            _state.update { if (it.kind == kind) it.copy(tuning = t) else it }
        }
    }

    override fun onCleared() {
        pending.value?.let { (k, t) -> kotlinx.coroutines.runBlocking { prefs.set(k, t) } }
    }
}
