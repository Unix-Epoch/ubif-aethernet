package dev.aethernet.linkpearl.feature.workorders

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.data.Auth
import dev.aethernet.linkpearl.core.data.AuthState
import dev.aethernet.linkpearl.core.data.StoreRef
import dev.aethernet.linkpearl.core.lock.AppLock
import dev.aethernet.linkpearl.core.lock.SealedBox
import dev.aethernet.linkpearl.core.lock.SealedOpener
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class LoadView { Loading, Ok, Error }

/** Why something could not be shown. */
enum class Problem { Offline, Forbidden, NoKey, RateLimited, SignedOut, NotFound, NotSetUp, Server }

fun problemOf(f: ApiResult.Failure): Problem = when (f.error) {
    ApiError.Offline -> Problem.Offline
    ApiError.Forbidden -> if (f.message?.contains("no key", ignoreCase = true) == true) Problem.NoKey else Problem.Forbidden
    ApiError.Unauthorized -> Problem.SignedOut
    ApiError.NotFound -> Problem.NotFound
    ApiError.RateLimited -> Problem.RateLimited
    ApiError.NotConfigured -> Problem.NotSetUp
    ApiError.Server -> Problem.Server
}

data class SearchUi(
    val query: String,
    val busy: Boolean = false,
    val results: List<WoRow> = emptyList(),
    /** A name / phone / IMEI query while locked: only a number can be searched. */
    val needsUnlock: Boolean = false,
    val problem: Problem? = null,
)

/** Everything the list pane draws. Customer names ([names]) are present only while unlocked. Never saved to instance state. */
data class WoListUi(
    val stores: List<StoreRef> = emptyList(),
    val store: Int? = null,
    val filter: LaneFilter = LaneFilter.All,
    val sort: WoSort = WoSort.Status,
    val view: LoadView = LoadView.Loading,
    val rows: List<WoRow> = emptyList(),
    val lanes: WoLanes? = null,
    /** The Follow-ups chip's count and the server's "today"; null from a tracker that predates Auto-Waymark (no chip then). */
    val followUps: FollowUpsInfo? = null,
    /** The Old chip's count: open work orders past [WoAging]'s limit in the store selection; null until counted (no chip then). */
    val old: Int? = null,
    val hasMore: Boolean = false,
    val loadingMore: Boolean = false,
    val refreshing: Boolean = false,
    /** With [LoadView.Error]: the whole message. With [LoadView.Ok]: a banner over the kept list. */
    val problem: Problem? = null,
    /** Phone time when the shown list was received, and the server clock's offset at that moment. */
    val receivedAtMs: Long? = null,
    val skewMs: Long = 0,
    val unlocked: Boolean = false,
    val names: Map<WoKey, String> = emptyMap(),
    val noKeyStores: Set<Int> = emptySet(),
    val query: String = "",
    val search: SearchUi? = null,
) {
    fun storeName(id: Int): String = stores.firstOrNull { it.id == id }?.label ?: "#$id"
    val showStore: Boolean get() = store == null
}

/**
 * The Work orders list and search. Plain rows always; with the lock open, the cards are fetched too (`cards=1`) and opened in memory
 * for the customer names, and name / phone / IMEI search runs over an in-memory index of the open and recent cards. Locking drops
 * names, index and any text search at once.
 */
class WorkOrdersViewModel(
    private val repo: WoRepository,
    private val lock: AppLock,
    private val auth: Auth?,
    private val prefs: WoStorePreference,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val work: CoroutineDispatcher = Dispatchers.Default,
    private val searchDebounceMs: Long = 300,
) : ViewModel() {
    private val _state = MutableStateFlow(WoListUi(unlocked = lock.isUnlocked.value))
    val state: StateFlow<WoListUi> = _state.asStateFlow()

    private var loadJob: Job? = null
    private var moreJob: Job? = null
    private var searchJob: Job? = null
    private var next: String? = null
    private var lastLoadAt = 0L
    /** Decrypted cards for search; memory only, null while locked or not built yet. */
    private var index: List<IndexEntry>? = null
    private var indexJob: Job? = null
    private var oldJob: Job? = null

    init {
        viewModelScope.launch {
            auth?.state?.collect { s -> if (s is AuthState.Registered) _state.update { it.copy(stores = s.stores) } }
        }
        // A tag or follow-up changed from the detail: update that row at once, then re-list quietly (counts, the Follow-ups filter).
        viewModelScope.launch {
            repo.changed.collect { row ->
                fun patch(r: WoRow) = if (r.key == row.key) r.copy(tags = row.tags, followUp = row.followUp) else r
                _state.update { s -> s.copy(rows = s.rows.map(::patch), search = s.search?.copy(results = s.search.results.map(::patch))) }
                if (_state.value.view == LoadView.Ok) load(manual = false, keepRows = true)
            }
        }
        viewModelScope.launch {
            val saved = prefs.store.first()
            _state.update { it.copy(store = saved) }
            load(manual = false, rescanOld = true)
            lock.isUnlocked.collect { unlocked ->
                if (unlocked == _state.value.unlocked) return@collect
                _state.update { it.copy(unlocked = unlocked) }
                if (unlocked) {
                    load(manual = false, keepRows = true)
                    _state.value.query.takeIf { it.isNotBlank() }?.let { runSearch(it) }
                } else {
                    dropSecrets()
                }
            }
        }
    }

    private fun dropSecrets() {
        indexJob?.cancel(); indexJob = null
        index = null
        _state.update { s ->
            val text = s.search?.let { !isNumberQuery(it.query) } == true
            s.copy(
                names = emptyMap(), noKeyStores = emptySet(),
                // a name / phone / IMEI search can only be shown unlocked; a number search stays (its rows are plain)
                search = when {
                    s.search == null -> null
                    text -> SearchUi(s.search.query, needsUnlock = true)
                    else -> s.search.copy(results = s.search.results.filter { r -> r.key in plainFindKeys })
                },
            )
        }
    }

    // ---- list ---------------------------------------------------------------------------------------------------------------

    fun pickStore(store: Int?) {
        if (store == _state.value.store) return
        viewModelScope.launch { prefs.set(store) }
        _state.update { it.copy(store = store) }
        load(manual = false, rescanOld = true)
    }

    fun pickFilter(f: LaneFilter) {
        if (f == _state.value.filter) return
        _state.update { it.copy(filter = f, sort = if (f == LaneFilter.Closed) WoSort.Closed else if (it.sort == WoSort.Closed) WoSort.Status else it.sort) }
        load(manual = false)
    }

    fun pickSort(s: WoSort) {
        if (s == _state.value.sort) return
        _state.update { it.copy(sort = s) }
        load(manual = false)
    }

    /** Pull to refresh and Retry. */
    fun refresh() = load(manual = true, keepRows = true, rescanOld = true)

    /** Screen shown again: re-list, not faster than once a minute. */
    fun refreshIfStale(maxAgeMs: Long = 60_000) {
        if (loadJob?.isActive == true) return
        if (nowMs() - lastLoadAt >= maxAgeMs) load(manual = false, keepRows = true, rescanOld = true)
    }

    private fun query(after: String? = null): ListQuery {
        val s = _state.value
        val opener = lock.opener
        val cards = s.unlocked && opener != null && (s.store == null || opener.hasKey(s.store))
        return ListQuery(store = s.store, filter = s.filter, sort = s.sort, cards = cards, after = after)
    }

    /** [rescanOld]: also recount the Old chip (first load, store change, refresh); the Old filter itself always recounts. */
    private fun load(manual: Boolean, keepRows: Boolean = false, rescanOld: Boolean = false) {
        loadJob?.cancel(); moreJob?.cancel()
        if (_state.value.filter == LaneFilter.Old) return loadOld(manual, keepRows)
        val q = query()
        val cached = repo.lastGood(q)
        _state.update {
            when {
                keepRows && it.view == LoadView.Ok -> it.copy(refreshing = manual, problem = null)
                cached != null -> it.copy(view = LoadView.Ok, rows = cached.first.rows, lanes = cached.first.lanes ?: it.lanes, followUps = cached.first.followUps ?: it.followUps, hasMore = false, receivedAtMs = cached.second, refreshing = true, problem = null)
                else -> it.copy(view = LoadView.Loading, rows = emptyList(), hasMore = false, refreshing = false, problem = null)
            }
        }
        loadJob = viewModelScope.launch {
            var r = repo.list(q)
            if (r is ApiResult.Failure && q.cards && problemOf(r) == Problem.NoKey) r = repo.list(q.copy(cards = false))
            when (r) {
                is ApiResult.Success -> {
                    val page = r.value
                    val at = nowMs()
                    lastLoadAt = at
                    repo.remember(q, page, at)
                    next = page.next
                    val names = openNames(page.rows)
                    _state.update {
                        it.copy(
                            view = LoadView.Ok, rows = page.rows.map { row -> row.copy(card = null) }, lanes = page.lanes ?: it.lanes, followUps = page.followUps ?: it.followUps,
                            hasMore = page.next != null, refreshing = false, problem = null, receivedAtMs = at, skewMs = skew(page.now, at),
                            names = if (it.unlocked) it.names + names else emptyMap(), noKeyStores = page.noKey.toSet(),
                        )
                    }
                    if (rescanOld) countOld()
                }
                is ApiResult.Failure -> {
                    val p = problemOf(r)
                    _state.update {
                        if (it.rows.isNotEmpty()) it.copy(view = LoadView.Ok, refreshing = false, problem = p)
                        else it.copy(view = LoadView.Error, refreshing = false, problem = p)
                    }
                }
            }
        }
    }

    /** The Old filter: every old open work order of the store selection at once (no paging), in the chosen order. */
    private fun loadOld(manual: Boolean, keepRows: Boolean) {
        oldJob?.cancel()
        val q = query()
        _state.update {
            if (keepRows && it.view == LoadView.Ok) it.copy(refreshing = manual, problem = null)
            else it.copy(view = LoadView.Loading, rows = emptyList(), hasMore = false, refreshing = false, problem = null)
        }
        loadJob = viewModelScope.launch {
            val at = nowMs()
            val serverNow = at + _state.value.skewMs
            var r = repo.oldRows(q.store, q.cards, serverNow)
            if (r is ApiResult.Failure && q.cards && problemOf(r) == Problem.NoKey) r = repo.oldRows(q.store, false, serverNow)
            when (r) {
                is ApiResult.Success -> {
                    lastLoadAt = at
                    next = null
                    val rows = if (q.sort == WoSort.Updated) r.value.sortedByDescending { it.updatedAt.orEmpty() } else r.value
                    val names = openNames(rows)
                    _state.update {
                        it.copy(
                            view = LoadView.Ok, rows = rows.map { row -> row.copy(card = null) }, old = rows.size, hasMore = false, refreshing = false, problem = null,
                            receivedAtMs = at, names = if (it.unlocked) it.names + names else emptyMap(),
                        )
                    }
                }
                is ApiResult.Failure -> {
                    val p = problemOf(r)
                    _state.update {
                        if (it.rows.isNotEmpty()) it.copy(view = LoadView.Ok, refreshing = false, problem = p)
                        else it.copy(view = LoadView.Error, refreshing = false, problem = p)
                    }
                }
            }
        }
    }

    /** The Old chip's count for the current store selection (plain rows, no cards); a failure keeps the last count. */
    private fun countOld() {
        oldJob?.cancel()
        val store = _state.value.store
        oldJob = viewModelScope.launch {
            val r = repo.oldRows(store, cards = false, nowMs = nowMs() + _state.value.skewMs)
            if (r is ApiResult.Success && _state.value.store == store) _state.update { it.copy(old = r.value.size) }
        }
    }

    /** Paging on scroll. */
    fun loadMore() {
        val after = next ?: return
        if (moreJob?.isActive == true || loadJob?.isActive == true) return
        _state.update { it.copy(loadingMore = true) }
        val q = query(after)
        moreJob = viewModelScope.launch {
            var r = repo.list(q)
            if (r is ApiResult.Failure && q.cards && problemOf(r) == Problem.NoKey) r = repo.list(q.copy(cards = false))
            when (r) {
                is ApiResult.Success -> {
                    next = r.value.next
                    val names = openNames(r.value.rows)
                    _state.update { s ->
                        val have = s.rows.map { it.key }.toHashSet()
                        s.copy(
                            rows = s.rows + r.value.rows.filter { it.key !in have }.map { it.copy(card = null) },
                            hasMore = r.value.next != null, loadingMore = false,
                            names = if (s.unlocked) s.names + names else emptyMap(),
                        )
                    }
                }
                is ApiResult.Failure -> _state.update { it.copy(loadingMore = false, problem = problemOf(r)) }
            }
        }
    }

    /** Opens the rows' cards (when unlocked) and returns their customer names. */
    private suspend fun openNames(rows: List<WoRow>): Map<WoKey, String> {
        val opener = lock.opener ?: return emptyMap()
        if (rows.none { it.card != null }) return emptyMap()
        return withContext(work) {
            buildMap { rows.forEach { r -> openCard(opener, r)?.name?.let { put(r.key, it) } } }
        }
    }

    private fun openCard(opener: SealedOpener, r: WoRow): Card? {
        val sealed = r.card ?: return null
        if (!opener.hasKey(r.store)) return null
        return try { Card.from(opener.openJson(r.store, sealed, SealedBox.Aad.card(r.store, r.wo))) } catch (e: CancellationException) { throw e } catch (_: Exception) { null }
    }

    private fun skew(serverNow: String?, at: Long): Long =
        serverNow?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() - at }.getOrNull() } ?: 0L

    // ---- search -------------------------------------------------------------------------------------------------------------

    /** Keys of rows that came from the plain number lookup (kept when the lock closes). */
    private var plainFindKeys: Set<WoKey> = emptySet()

    fun setQuery(text: String) {
        _state.update { it.copy(query = text) }
        searchJob?.cancel()
        val q = text.trim()
        if (q.isEmpty() || (isNumberQuery(q) && digitsOf(q).length < 3)) {
            _state.update { it.copy(search = null) }
            return
        }
        searchJob = viewModelScope.launch {
            delay(searchDebounceMs)
            runSearch(q)
        }
    }

    fun clearQuery() = setQuery("")

    private suspend fun runSearch(raw: String) {
        val q = raw.trim()
        val unlocked = _state.value.unlocked && lock.opener != null
        val number = isNumberQuery(q)
        if (!number && !unlocked) {
            _state.update { it.copy(search = SearchUi(q, needsUnlock = true)) }
            return
        }
        _state.update { it.copy(search = SearchUi(q, busy = true)) }
        val digits = digitsOf(q)
        var problem: Problem? = null
        val found = mutableListOf<WoRow>()
        if (number && digits.length in 3..12 && !digits.startsWith("0")) {
            when (val r = repo.find(digits)) {
                is ApiResult.Success -> found += r.value.rows
                is ApiResult.Failure -> problem = problemOf(r)
            }
            plainFindKeys = found.map { it.key }.toSet()
        }
        val names = HashMap<WoKey, String>()
        if (unlocked) {
            val idx = ensureIndex()
            if (idx == null && problem == null) problem = Problem.Offline
            idx?.let { CardMatch.search(it, q) }?.forEach { e ->
                if (found.none { it.key == e.row.key }) found += e.row
                e.card.name?.let { names[e.row.key] = it }
            }
        }
        if (_state.value.query.trim() != q) return
        _state.update { s ->
            s.copy(
                search = SearchUi(q, results = found.map { it.copy(card = null) }, problem = problem.takeIf { found.isEmpty() }),
                names = if (s.unlocked) s.names + names else s.names,
            )
        }
    }

    /** Fetches every open and recent card once per unlock, opens them, keeps them in memory. */
    private suspend fun ensureIndex(): List<IndexEntry>? {
        index?.let { return it }
        val opener = lock.opener ?: return null
        val rows = mutableListOf<WoRow>()
        for (filter in listOf(LaneFilter.All, LaneFilter.Recent)) {
            var after: String? = null
            var pages = 0
            do {
                val r = repo.list(ListQuery(store = null, filter = filter, sort = if (filter == LaneFilter.Recent) WoSort.Closed else WoSort.Status, cards = true, after = after, limit = 100))
                if (r !is ApiResult.Success) return null
                rows += r.value.rows
                after = r.value.next
                pages++
            } while (after != null && pages < 20)
        }
        val built = withContext(work) { rows.mapNotNull { r -> openCard(opener, r)?.let { IndexEntry(r.copy(card = null), it) } } }
        if (!_state.value.unlocked) return null
        index = built
        return built
    }

    companion object {
        fun isNumberQuery(q: String) = q.isNotBlank() && q.all { it.isDigit() || it in " ()+-." } && q.any { it.isDigit() }
    }
}
