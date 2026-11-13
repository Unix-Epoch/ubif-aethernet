package dev.aethernet.linkpearl.feature.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.aethernet.linkpearl.core.data.FailureReason
import dev.aethernet.linkpearl.core.data.HomeData
import dev.aethernet.linkpearl.core.data.HomeRepository
import dev.aethernet.linkpearl.core.data.HomeResult
import dev.aethernet.linkpearl.core.data.StoreRef
import dev.aethernet.linkpearl.core.data.StoreScope
import dev.aethernet.linkpearl.core.di.AppContainer
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class HomeView { Loading, Ok, Error }

/**
 * Everything Home draws. Mirrors the web app's states: [view] Ok with [offline] (the phone's last copy), [failed] (a refresh failed,
 * old numbers stay), or Error (nothing to show). [stores] fills the switcher.
 */
data class HomeUiState(
    val scope: StoreScope = StoreScope.All,
    val view: HomeView = HomeView.Loading,
    val data: HomeData? = null,
    val offline: Boolean = false,
    val failed: Boolean = false,
    val busy: Boolean = false,
    val stores: List<StoreRef> = emptyList(),
)

class HomeViewModel(
    private val repo: HomeRepository,
    private val prefs: StorePreference,
    private val nowMs: () -> Long = System::currentTimeMillis,
) : ViewModel() {
    private val _state = MutableStateFlow(HomeUiState())
    val state: StateFlow<HomeUiState> = _state.asStateFlow()

    private var job: Job? = null
    private var lastData: HomeData? = null
    private var lastScope: StoreScope? = null
    private var lastAt = 0L

    init {
        viewModelScope.launch { load(prefs.scope.first(), manual = false) }
    }

    fun pick(scope: StoreScope) {
        viewModelScope.launch { prefs.set(scope) }
        load(scope, manual = false)
    }

    /** The refresh button and Retry: skips the server's cache. */
    fun refresh() = load(_state.value.scope, manual = true)

    /** Called while the screen is visible, once a minute and on return to the app. */
    fun refreshIfStale(maxAgeMs: Long = 60_000) {
        if (_state.value.view == HomeView.Loading && job?.isActive == true) return
        if (nowMs() - lastAt >= maxAgeMs) load(_state.value.scope, manual = false)
    }

    private fun load(scope: StoreScope, manual: Boolean) {
        job?.cancel()
        val have = if (lastScope == scope) lastData else null
        _state.update {
            it.copy(
                scope = scope, busy = true, failed = false,
                view = if (have == null) HomeView.Loading else HomeView.Ok,
                data = have, offline = if (have == null) false else it.offline,
            )
        }
        job = viewModelScope.launch {
            when (val r = repo.load(scope, fresh = manual)) {
                is HomeResult.Ok -> {
                    lastData = r.data; lastScope = scope; lastAt = nowMs()
                    _state.update { it.copy(view = HomeView.Ok, data = r.data, offline = r.cached, failed = false, busy = false, stores = r.data.stores.ifEmpty { it.stores }) }
                }
                is HomeResult.Failed -> if (r.reason == FailureReason.NotYourStore && scope is StoreScope.One) {
                    // The chosen store is no longer approved for this phone: back to All stores.
                    viewModelScope.launch { prefs.set(StoreScope.All) }
                    load(StoreScope.All, manual = false)
                } else _state.update {
                    when {
                        have != null && r.reason == FailureReason.Offline -> it.copy(view = HomeView.Ok, offline = true, busy = false)
                        have != null -> it.copy(view = HomeView.Ok, failed = true, busy = false)
                        else -> it.copy(view = HomeView.Error, data = null, busy = false)
                    }
                }
            }
        }
    }

    companion object {
        fun factory(c: AppContainer): ViewModelProvider.Factory = viewModelFactory {
            initializer { HomeViewModel(c.get<HomeRepository>(), c.get<StorePreference>()) }
        }
    }
}
