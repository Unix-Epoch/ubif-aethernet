package dev.aethernet.linkpearl.feature.prices

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.data.Auth
import dev.aethernet.linkpearl.core.data.AuthState
import dev.aethernet.linkpearl.core.data.StoreRef
import dev.aethernet.linkpearl.feature.workorders.LoadView
import dev.aethernet.linkpearl.feature.workorders.Problem
import dev.aethernet.linkpearl.feature.workorders.problemOf
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Everything Prices draws. [list] is the store's device list (loading, ok, error); [shown] the devices matching [query] (the chips);
 * [chosen] the picked one and [prices] its answer ([matches], two for a Fold, one shown at a time: [matchIndex]).
 */
data class PricesUi(
    val store: Int? = null,
    val stores: List<StoreRef> = emptyList(),
    val query: String = "",
    val list: LoadView = LoadView.Loading,
    val syncedAt: String? = null,
    val devices: List<PriceDevice> = emptyList(),
    val shown: List<PriceDevice> = emptyList(),
    val chosen: PriceDevice? = null,
    /** Null until a device is chosen. */
    val prices: LoadView? = null,
    val matches: List<PriceMatch> = emptyList(),
    val matchIndex: Int = 0,
    val problem: Problem? = null,
    val refreshing: Boolean = false,
) {
    /** The store has no Price sheet (the server answers `syncedAt: null, devices: []`). */
    val noSheet: Boolean get() = list == LoadView.Ok && syncedAt == null && devices.isEmpty()
    val match: PriceMatch? get() = matches.getOrNull(matchIndex) ?: matches.firstOrNull()
    fun storeLabel(): String = stores.firstOrNull { it.id == store }?.label ?: store?.let { "#$it" } ?: ""
}

class PricesViewModel(
    private val repo: PricesRepository,
    auth: Auth?,
    private val initialStore: Int?,
    private val debounceMs: Long = 300,
) : ViewModel() {
    private val _state = MutableStateFlow(PricesUi(store = initialStore))
    val state: StateFlow<PricesUi> = _state.asStateFlow()

    private var listJob: Job? = null
    private var priceJob: Job? = null

    init {
        if (auth == null) loadList(fresh = false)
        else viewModelScope.launch {
            var started = false
            auth.state.collect { s ->
                if (s !is AuthState.Registered) return@collect
                val current = _state.value.store
                val pick = current?.takeIf { id -> s.stores.any { it.id == id } } ?: s.stores.firstOrNull()?.id
                _state.update { it.copy(stores = s.stores, store = pick) }
                if (!started || pick != current) { started = true; loadList(fresh = false) }
            }
        }
    }

    fun pickStore(store: Int) {
        if (store == _state.value.store) return
        _state.update { it.copy(store = store, chosen = null, prices = null, matches = emptyList(), devices = emptyList(), shown = emptyList(), syncedAt = null) }
        loadList(fresh = false)
    }

    fun setQuery(text: String) {
        _state.update { it.copy(query = text) }
        refilter(debounce = true)
    }

    fun clearQuery() = setQuery("")

    fun choose(device: PriceDevice) {
        if (device == _state.value.chosen && _state.value.prices == LoadView.Ok) return
        _state.update { it.copy(chosen = device) }
        loadPrices(device, delayMs = 0)
    }

    fun pickMatch(index: Int) = _state.update { it.copy(matchIndex = index.coerceIn(0, (it.matches.size - 1).coerceAtLeast(0))) }

    /** Pull to refresh and Retry: the device list again (skipping the phone's copy), then the chosen device. */
    fun refresh() {
        _state.update { it.copy(refreshing = it.list == LoadView.Ok) }
        loadList(fresh = true)
    }

    private fun loadList(fresh: Boolean) {
        val store = _state.value.store ?: return
        listJob?.cancel()
        _state.update { if (it.list == LoadView.Ok && it.refreshing) it.copy(problem = null) else it.copy(list = LoadView.Loading, problem = null) }
        listJob = viewModelScope.launch {
            when (val r = repo.devices(store, fresh)) {
                is ApiResult.Success -> {
                    _state.update { it.copy(list = LoadView.Ok, devices = r.value.devices, syncedAt = r.value.syncedAt, refreshing = false, problem = null) }
                    refilter(debounce = false, force = fresh)
                }
                is ApiResult.Failure -> {
                    val p = problemOf(r).let { if (it == Problem.NotFound) Problem.Server else it }
                    _state.update { if (it.list == LoadView.Ok && it.devices.isNotEmpty()) it.copy(problem = p, refreshing = false) else it.copy(list = LoadView.Error, problem = p, refreshing = false) }
                }
            }
        }
    }

    /** Local filtering of the device list; the chosen device stays chosen while it still matches, else the first match is taken. */
    private fun refilter(debounce: Boolean, force: Boolean = false) {
        val s = _state.value
        val shown = PriceFmt.filter(s.devices, s.query)
        val chosen = s.chosen?.takeIf { c -> shown.any { it == c } } ?: shown.firstOrNull()
        val changed = chosen != s.chosen
        _state.update { it.copy(shown = shown, chosen = chosen, prices = if (chosen == null) null else it.prices, matches = if (chosen == null) emptyList() else it.matches) }
        if (chosen != null && (changed || force || s.prices == null)) loadPrices(chosen, if (debounce) debounceMs else 0)
        else if (chosen == null) priceJob?.cancel()
    }

    private fun loadPrices(device: PriceDevice, delayMs: Long) {
        val store = _state.value.store ?: return
        priceJob?.cancel()
        _state.update { it.copy(prices = if (it.matches.isNotEmpty() && it.prices == LoadView.Ok) LoadView.Ok else LoadView.Loading) }
        priceJob = viewModelScope.launch {
            if (delayMs > 0) delay(delayMs)
            _state.update { it.copy(prices = LoadView.Loading) }
            when (val r = repo.prices(store, device.key ?: device.name)) {
                is ApiResult.Success -> _state.update {
                    it.copy(prices = LoadView.Ok, matches = r.value.matches, matchIndex = 0, syncedAt = r.value.syncedAt ?: it.syncedAt, problem = null)
                }
                is ApiResult.Failure -> {
                    val p = problemOf(r).let { if (it == Problem.NotFound) Problem.Server else it }
                    _state.update { it.copy(prices = LoadView.Error, matches = emptyList(), problem = p) }
                }
            }
        }
    }
}
