package dev.aethernet.linkpearl.feature.alerts

import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

sealed interface SettingsUi {
    data object Loading : SettingsUi
    data class Failed(val offline: Boolean) : SettingsUi
    /** [error] is the one plain line shown when the last edit could not be saved. */
    data class Ready(val bundle: SettingsBundle, val error: String? = null) : SettingsUi
}

/** Loads the settings and applies edits optimistically: validate against the server's ranges, show at once, PUT, roll back on failure. */
class AlertSettingsController(private val remote: AlertsRemote, private val scope: CoroutineScope) {
    private val _state = MutableStateFlow<SettingsUi>(SettingsUi.Loading)
    val state: StateFlow<SettingsUi> = _state.asStateFlow()
    private val mutex = Mutex()
    private var pending = 0
    private var loading = false

    fun load(force: Boolean = false) {
        if (loading || (!force && _state.value is SettingsUi.Ready)) return
        loading = true
        if (_state.value !is SettingsUi.Ready) _state.value = SettingsUi.Loading
        scope.launch {
            when (val r = remote.settings()) {
                is ApiResult.Success -> _state.value = SettingsUi.Ready(r.value)
                is ApiResult.Failure -> if (_state.value !is SettingsUi.Ready) _state.value = SettingsUi.Failed(r.error == ApiError.Offline)
            }
            loading = false
        }
    }

    fun dismissError() = _state.update { if (it is SettingsUi.Ready) it.copy(error = null) else it }

    /** Returns false when the edit is refused before sending (out of range, equal quiet times, not loaded). */
    fun edit(e: SettingsEdit): Boolean {
        val cur = _state.value as? SettingsUi.Ready ?: return false
        if (e.problem(cur.bundle.settings, cur.bundle.ranges) != null) return false
        val undo = e.inverse(cur.bundle.settings)
        _state.value = cur.copy(bundle = cur.bundle.copy(settings = e.apply(cur.bundle.settings)), error = null)
        pending++
        scope.launch {
            val r = mutex.withLock { remote.putSettings(e.json()) }
            pending--
            when (r) {
                is ApiResult.Success -> if (pending == 0) _state.update { if (it is SettingsUi.Ready) it.copy(bundle = r.value) else it }
                is ApiResult.Failure -> _state.update {
                    if (it is SettingsUi.Ready) it.copy(bundle = it.bundle.copy(settings = undo.apply(it.bundle.settings)), error = "Couldn't save") else it
                }
            }
        }
        return true
    }
}
