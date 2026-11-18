package dev.aethernet.linkpearl.feature.scan

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.nav.Routes
import dev.aethernet.linkpearl.feature.retrace.RetraceRepository
import dev.aethernet.linkpearl.feature.workorders.WoStorePreference
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** [open] = a route to go to now (cleared by [ScanViewModel.opened]); [message] = why the last code opened nothing. */
data class ScanUi(val busy: Boolean = false, val message: String? = null, val open: String? = null)

/**
 * A work order number opens `workorders/<number>` (Work orders searches it and opens the single match). A label is looked up in
 * Retrace, the remembered store first, then the phone's other stores; the first store that knows it opens its label page.
 */
class ScanViewModel(
    private val retrace: RetraceRepository,
    private val stores: List<Int>,
    private val store: WoStorePreference,
) : ViewModel() {
    private val _state = MutableStateFlow(ScanUi())
    val state: StateFlow<ScanUi> = _state.asStateFlow()

    fun onCode(raw: String) {
        val s = _state.value
        if (s.busy || s.open != null) return
        when (val t = ScanCode.parse(raw)) {
            null -> _state.update { it.copy(message = NOT_A_LABEL) }
            is ScanTarget.WorkOrder -> _state.update { it.copy(message = null, open = Routes.workOrder(t.number)) }
            is ScanTarget.Label -> lookUp(t.label)
        }
    }

    private fun lookUp(label: String) {
        _state.update { it.copy(busy = true, message = null) }
        viewModelScope.launch {
            val preferred = runCatching { store.store.first() }.getOrNull()
            var failed = false
            for (id in ScanCode.storeOrder(preferred, stores)) {
                when (val r = retrace.label(id, label)) {
                    is ApiResult.Success -> { _state.update { it.copy(busy = false, open = Routes.retraceLabel(id, label)) }; return@launch }
                    is ApiResult.Failure -> if (r.status != 404) failed = true
                }
            }
            _state.update { it.copy(busy = false, message = if (failed) "Couldn't load" else "$label not found") }
        }
    }

    fun opened() = _state.update { it.copy(open = null) }

    companion object { const val NOT_A_LABEL = "Not a work order or serial label" }
}
