package dev.aethernet.linkpearl.feature.trends

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.data.Auth
import dev.aethernet.linkpearl.core.data.AuthState
import dev.aethernet.linkpearl.core.data.StoreRef
import dev.aethernet.linkpearl.core.data.StoreScope
import dev.aethernet.linkpearl.feature.workorders.LoadView
import dev.aethernet.linkpearl.feature.workorders.Problem
import dev.aethernet.linkpearl.feature.workorders.problemOf
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.LocalDate

/**
 * Everything Trends draws. [at] is the chosen day (null = the current period). [data] is the last answer for this scope, period and
 * day; with [problem] set it stays on screen under a notice (offline, couldn't refresh). [stores] fills the store sheet.
 */
data class TrendsUi(
    val scope: StoreScope = StoreScope.All,
    val period: TrendPeriod = TrendPeriod.Week,
    val at: String? = null,
    val view: LoadView = LoadView.Loading,
    val data: TrendsData? = null,
    val problem: Problem? = null,
    val refreshing: Boolean = false,
    val stores: List<StoreRef> = emptyList(),
    /** The phone's day, used only until the server has said what "today" is. */
    val deviceToday: String = LocalDate.now().toString(),
) {
    val today: LocalDate? get() = TrendsFmt.date(data?.today) ?: TrendsFmt.date(deviceToday)

    /** The shown period, from the answer when it has one, else worked out on the phone (while paging). */
    val range: Pair<LocalDate, LocalDate>? get() {
        val from = TrendsFmt.date(data?.from); val to = TrendsFmt.date(data?.to)
        if (from != null && to != null && data?.period == period.key && (at == null || TrendsFmt.date(at)?.let { it in from..to } == true)) return from to to
        val anchor = TrendsFmt.date(at) ?: today ?: return null
        return TrendsFmt.range(period, anchor)
    }

    val periodLabel: String get() = range?.let { TrendsFmt.periodLabel(period, it.first, it.second, today) } ?: ""

    /** No next page once the shown period holds today. */
    val canNext: Boolean get() { val r = range ?: return false; val t = today ?: return false; return r.second < t }

    val canPrev: Boolean get() = range != null
}

class TrendsViewModel(
    private val repo: TrendsRepository,
    auth: Auth?,
    initial: StoreScope,
    today: () -> LocalDate = { LocalDate.now() },
) : ViewModel() {
    private val _state = MutableStateFlow(TrendsUi(scope = initial, deviceToday = today().toString()))
    val state: StateFlow<TrendsUi> = _state.asStateFlow()

    private var job: Job? = null
    /** Answers already seen this visit, so flipping back to a period shows it at once (and refreshes it behind). */
    private val seen = HashMap<String, TrendsData>()
    private fun key(s: TrendsUi) = "${s.scope.key}|${s.period.key}|${s.at ?: "now"}"

    init {
        viewModelScope.launch {
            auth?.state?.collect { s -> if (s is AuthState.Registered) _state.update { it.copy(stores = s.stores) } }
        }
        load(manual = false)
    }

    fun pickPeriod(p: TrendPeriod) {
        if (p == _state.value.period) return
        _state.update { it.copy(period = p, at = null) }
        load(manual = false)
    }

    fun pickScope(scope: StoreScope) {
        if (scope == _state.value.scope) return
        _state.update { it.copy(scope = scope) }
        load(manual = false)
    }

    /** The period before: the server's rule is "send the day before `from`". */
    fun previous() {
        val r = _state.value.range ?: return
        _state.update { it.copy(at = r.first.minusDays(1).toString()) }
        load(manual = false)
    }

    fun next() {
        val s = _state.value
        if (!s.canNext) return
        val r = s.range ?: return
        val day = r.second.plusDays(1)
        val today = s.today
        // The period holding today is the current one: ask without `at`, like the first load.
        val at = if (today != null && TrendsFmt.range(s.period, day).let { today in it.first..it.second }) null else day.toString()
        _state.update { it.copy(at = at) }
        load(manual = false)
    }

    fun refresh() = load(manual = true)

    private fun load(manual: Boolean) {
        job?.cancel()
        val s = _state.value
        val k = key(s)
        val have = seen[k]
        _state.update {
            when {
                manual && it.data != null -> it.copy(refreshing = true, problem = null)
                have != null -> it.copy(view = LoadView.Ok, data = have, problem = null, refreshing = false)
                else -> it.copy(view = LoadView.Loading, data = null, problem = null, refreshing = false)
            }
        }
        job = viewModelScope.launch {
            when (val r = repo.load(s.scope, s.period, s.at, fresh = manual)) {
                is ApiResult.Success -> {
                    seen[k] = r.value
                    _state.update { it.copy(view = LoadView.Ok, data = r.value, problem = null, refreshing = false) }
                }
                is ApiResult.Failure -> {
                    val p = problemOf(r).let { if (it == Problem.NotFound) Problem.Server else it }
                    _state.update { if (it.data != null) it.copy(view = LoadView.Ok, problem = p, refreshing = false) else it.copy(view = LoadView.Error, problem = p, refreshing = false) }
                }
            }
        }
    }
}
