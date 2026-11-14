package dev.aethernet.linkpearl.feature.retrace

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.data.Auth
import dev.aethernet.linkpearl.core.data.AuthState
import dev.aethernet.linkpearl.feature.workorders.LoadView
import dev.aethernet.linkpearl.feature.workorders.Problem
import dev.aethernet.linkpearl.feature.workorders.WoStorePreference
import dev.aethernet.linkpearl.feature.workorders.problemOf
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Why a Retrace call failed, in the work orders' words (a 404 from the tracker is the generic "Couldn't load"). */
fun retraceProblem(f: ApiResult.Failure): Problem = if (f.error == ApiError.NotFound) Problem.Server else problemOf(f)

/**
 * Retrace home: items (with search and the label jump) or purchase orders, for ONE store: the one chosen on Work orders if there is one,
 * else the first of the phone's stores. Pages with the server's cursor; the last sweep is the "As of".
 */
class RetraceViewModel(
    private val repo: RetraceRepository,
    private val auth: Auth?,
    private val prefs: WoStorePreference,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val searchDebounceMs: Long = 300,
) : ViewModel() {
    private val _state = MutableStateFlow(RetraceUi())
    val state: StateFlow<RetraceUi> = _state.asStateFlow()

    private var loadJob: Job? = null
    private var moreJob: Job? = null
    private var searchJob: Job? = null
    private var next: String? = null
    private var lastLoadAt = 0L

    init {
        viewModelScope.launch {
            val saved = prefs.store.first()
            var started = false
            auth?.state?.collect { s ->
                if (s !is AuthState.Registered) return@collect
                _state.update { it.copy(stores = s.stores) }
                val current = _state.value.store
                if (current == null || s.stores.none { it.id == current }) {
                    val pick = s.stores.firstOrNull { it.id == saved }?.id ?: s.stores.firstOrNull()?.id
                    _state.update { it.copy(store = pick) }
                    if (pick != null && !started) { started = true; load(manual = false) }
                }
            }
        }
    }

    fun pickStore(store: Int) {
        if (store == _state.value.store) return
        _state.update { it.copy(store = store) }
        load(manual = false)
    }

    fun pickView(view: RetraceView) {
        if (view == _state.value.view) return
        _state.update { it.copy(view = view) }
        load(manual = false)
    }

    fun setQuery(text: String) {
        _state.update { it.copy(query = text) }
        searchJob?.cancel()
        searchJob = viewModelScope.launch { delay(searchDebounceMs); if (_state.value.view == RetraceView.Items) load(manual = false) }
    }

    fun clearQuery() = setQuery("")

    fun refresh() = load(manual = true, keepRows = true)

    /** Screen shown again: reload, not faster than once a minute. */
    fun refreshIfStale(maxAgeMs: Long = 60_000) {
        if (loadJob?.isActive == true || _state.value.store == null) return
        if (nowMs() - lastLoadAt >= maxAgeMs) load(manual = false, keepRows = true)
    }

    private fun load(manual: Boolean, keepRows: Boolean = false) {
        val store = _state.value.store ?: return
        loadJob?.cancel(); moreJob?.cancel()
        val view = _state.value.view
        val q = _state.value.query.trim()
        _state.update {
            if (keepRows && it.load == LoadView.Ok) it.copy(refreshing = manual, problem = null)
            else it.copy(load = LoadView.Loading, items = emptyList(), labels = emptyList(), pos = emptyList(), hasMore = false, loadingMore = false, refreshing = false, problem = null)
        }
        loadJob = viewModelScope.launch {
            when (view) {
                RetraceView.Items -> when (val r = repo.items(store, q, null)) {
                    is ApiResult.Success -> succeed(r.value.next) { it.copy(items = r.value.items, labels = r.value.labels.orEmpty(), pos = emptyList(), asOf = r.value.asOf ?: it.asOf) }
                    is ApiResult.Failure -> fail(r)
                }
                RetraceView.PurchaseOrders -> when (val r = repo.pos(store, null)) {
                    is ApiResult.Success -> succeed(r.value.next) { it.copy(pos = r.value.pos, items = emptyList(), labels = emptyList()) }
                    is ApiResult.Failure -> fail(r)
                }
            }
        }
    }

    private fun succeed(nextCursor: String?, change: (RetraceUi) -> RetraceUi) {
        val at = nowMs(); lastLoadAt = at; next = nextCursor
        _state.update { change(it).copy(load = LoadView.Ok, hasMore = nextCursor != null, refreshing = false, problem = null, receivedAtMs = at) }
    }

    private fun fail(f: ApiResult.Failure) {
        val p = retraceProblem(f)
        _state.update {
            val have = it.items.isNotEmpty() || it.pos.isNotEmpty() || it.labels.isNotEmpty()
            if (have) it.copy(load = LoadView.Ok, refreshing = false, problem = p) else it.copy(load = LoadView.Error, refreshing = false, problem = p)
        }
    }

    /** Paging on scroll. */
    fun loadMore() {
        val after = next ?: return
        val store = _state.value.store ?: return
        if (moreJob?.isActive == true || loadJob?.isActive == true) return
        _state.update { it.copy(loadingMore = true) }
        val view = _state.value.view
        val q = _state.value.query.trim()
        moreJob = viewModelScope.launch {
            when (view) {
                RetraceView.Items -> when (val r = repo.items(store, q, after)) {
                    is ApiResult.Success -> { next = r.value.next; _state.update { s -> s.copy(items = s.items + r.value.items.filter { n -> s.items.none { it.item == n.item } }, hasMore = r.value.next != null, loadingMore = false) } }
                    is ApiResult.Failure -> _state.update { it.copy(loadingMore = false, problem = retraceProblem(r)) }
                }
                RetraceView.PurchaseOrders -> when (val r = repo.pos(store, after)) {
                    is ApiResult.Success -> { next = r.value.next; _state.update { s -> s.copy(pos = s.pos + r.value.pos.filter { n -> s.pos.none { it.po == n.po } }, hasMore = r.value.next != null, loadingMore = false) } }
                    is ApiResult.Failure -> _state.update { it.copy(loadingMore = false, problem = retraceProblem(r)) }
                }
            }
        }
    }
}

/** One item or label page. Loads when created; Retry and refresh load again. */
class RetraceDetailViewModel(
    private val repo: RetraceRepository,
    auth: Auth?,
    private val target: RtTarget,
) : ViewModel() {
    private val _item = MutableStateFlow(RtDetailUi<RtItemResponse>())
    private val _label = MutableStateFlow(RtDetailUi<RtLabelResponse>())
    val item: StateFlow<RtDetailUi<RtItemResponse>> = _item.asStateFlow()
    val label: StateFlow<RtDetailUi<RtLabelResponse>> = _label.asStateFlow()
    private var job: Job? = null

    init {
        viewModelScope.launch { auth?.state?.collect { s -> if (s is AuthState.Registered) { _item.update { it.copy(stores = s.stores) }; _label.update { it.copy(stores = s.stores) } } } }
        load(manual = false)
    }

    fun refresh() = load(manual = true)

    private fun load(manual: Boolean) {
        job?.cancel()
        job = viewModelScope.launch {
            when (val t = target) {
                is RtTarget.Item -> {
                    _item.update { if (it.data != null) it.copy(refreshing = manual, problem = null) else it.copy(view = LoadView.Loading, problem = null) }
                    when (val r = repo.item(t.store, t.item)) {
                        is ApiResult.Success -> _item.update { it.copy(view = LoadView.Ok, data = r.value, refreshing = false, problem = null) }
                        is ApiResult.Failure -> _item.update { if (it.data != null) it.copy(view = LoadView.Ok, refreshing = false, problem = retraceProblem(r)) else it.copy(view = LoadView.Error, refreshing = false, problem = retraceProblem(r)) }
                    }
                }
                is RtTarget.Label -> {
                    _label.update { if (it.data != null) it.copy(refreshing = manual, problem = null) else it.copy(view = LoadView.Loading, problem = null) }
                    when (val r = repo.label(t.store, t.label)) {
                        is ApiResult.Success -> _label.update { it.copy(view = LoadView.Ok, data = r.value, refreshing = false, problem = null) }
                        is ApiResult.Failure -> _label.update { if (it.data != null) it.copy(view = LoadView.Ok, refreshing = false, problem = retraceProblem(r)) else it.copy(view = LoadView.Error, refreshing = false, problem = retraceProblem(r)) }
                    }
                }
            }
        }
    }
}
