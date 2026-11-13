package dev.aethernet.linkpearl.feature.alerts

import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.nav.NavBadges
import dev.aethernet.linkpearl.core.nav.TopLevel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant

/** The Alerts tab badge: the unread count of this phone's feed (the server already honours the type and store switches). */
class AlertsBadges(initial: Int = 0, scope: CoroutineScope) : NavBadges {
    private val unread = MutableStateFlow(initial.coerceAtLeast(0))
    override val counts: StateFlow<Map<TopLevel, Int>> =
        unread.map { if (it > 0) mapOf(TopLevel.Alerts to it) else emptyMap() }.stateIn(scope, SharingStarted.Eagerly, if (initial > 0) mapOf(TopLevel.Alerts to initial) else emptyMap())
    val value: Int get() = unread.value
    fun set(n: Int) { unread.value = n.coerceAtLeast(0) }
}

enum class FeedStatus { Ok, Offline, Error, NotConfigured, SignedOut }

data class FeedUi(
    val alerts: List<Alert> = emptyList(),
    val loaded: Boolean = false,
    val refreshing: Boolean = false,
    val loadingMore: Boolean = false,
    val more: Boolean = false,
    val next: Int? = null,
    /** Store filter: null is "All stores". */
    val store: Int? = null,
    val unreadOnly: Boolean = false,
    /** Unread in the whole feed (null until known). */
    val unread: Int? = null,
    val status: FeedStatus = FeedStatus.Ok,
    /** ISO time of the last successful load, for "Offline · as of …". */
    val loadedAt: String? = null,
    /** The server's clock at the last load; day headings are relative to it. */
    val now: String? = null,
    /** One plain line, e.g. a read mark that could not be saved. */
    val error: String? = null,
) {
    val visible: List<Alert> get() = if (unreadOnly) alerts.filter { !it.read } else alerts
}

/**
 * The feed in memory (last answer is kept while offline), paging, filters and read marks. App-wide singleton so the badge, the screen
 * and the notification action share one state.
 */
class AlertsFeed(
    private val remote: AlertsRemote,
    private val scope: CoroutineScope,
    private val badge: AlertsBadges,
    private val check: CheckState,
    private val onRead: (List<Int>) -> Unit = {},
    private val clock: () -> Instant = Instant::now,
) {
    private val _state = MutableStateFlow(FeedUi(unread = null))
    val state: StateFlow<FeedUi> = _state.asStateFlow()
    private var generation = 0

    fun setStore(store: Int?) {
        if (_state.value.store == store) return
        generation++
        _state.update { it.copy(store = store, alerts = emptyList(), loaded = false, more = false, next = null, error = null) }
        refresh()
    }

    fun setUnreadOnly(v: Boolean) = _state.update { it.copy(unreadOnly = v) }

    fun signedOut() { generation++; _state.value = FeedUi(status = FeedStatus.SignedOut); badge.set(0) }

    fun dismissError() = _state.update { it.copy(error = null) }

    /**
     * Loads the newest page. [seen] is true only while the Alerts screen is on screen: what the owner can see needs no notification, so
     * the background cursor moves up to it (only when the page reaches back to the stored cursor, so nothing unseen is skipped).
     */
    fun refresh(seen: Boolean = false) {
        val gen = ++generation
        val store = _state.value.store
        _state.update { it.copy(refreshing = true, loadingMore = false) }
        scope.launch {
            val r = remote.feed(store)
            if (gen != generation) return@launch
            when (r) {
                is ApiResult.Success -> {
                    val p = r.value
                    if (store == null) { badge.set(p.unread); runCatching { check.setUnread(p.unread) } }
                    _state.update {
                        it.copy(
                            alerts = p.alerts, loaded = true, refreshing = false, more = p.more, next = p.next, status = FeedStatus.Ok,
                            unread = if (store == null) p.unread else it.unread, now = p.now ?: clock().toString(), loadedAt = clock().toString(),
                        )
                    }
                    if (seen && store == null) markSeen(p)
                }
                is ApiResult.Failure -> _state.update { it.copy(refreshing = false, status = statusOf(r.error)) }
            }
        }
    }

    private suspend fun markSeen(p: FeedPage) {
        val stored = runCatching { check.cursor() }.getOrNull() ?: return
        val reachesBack = !p.more || (p.alerts.lastOrNull()?.id ?: Int.MAX_VALUE) <= stored
        if (p.cursor > stored && reachesBack) runCatching { check.setCursor(p.cursor) }
    }

    fun loadMore() {
        val s = _state.value
        val before = s.next ?: return
        if (!s.more || s.loadingMore || s.refreshing) return
        val gen = generation
        _state.update { it.copy(loadingMore = true) }
        scope.launch {
            val r = remote.feed(s.store, before = before)
            if (gen != generation) return@launch
            when (r) {
                is ApiResult.Success -> _state.update {
                    val known = it.alerts.map { a -> a.id }.toSet()
                    it.copy(alerts = it.alerts + r.value.alerts.filter { a -> a.id !in known }, more = r.value.more, next = r.value.next, loadingMore = false)
                }
                is ApiResult.Failure -> _state.update { it.copy(loadingMore = false, status = statusOf(r.error)) }
            }
        }
    }

    /** Optimistic: shown read at once, the badge drops, the notification goes; undone when the server refuses. */
    fun markRead(ids: List<Int>) {
        if (ids.isEmpty()) return
        val was = _state.value.alerts.filter { it.id in ids && !it.read }.map { it.id }
        _state.update { s -> s.copy(alerts = s.alerts.map { if (it.id in ids) it.copy(read = true) else it }, error = null) }
        if (was.isNotEmpty()) badge.set(badge.value - was.size)
        onRead(ids)
        scope.launch {
            when (val r = remote.markRead(ids)) {
                is ApiResult.Success -> { badge.set(r.value); runCatching { check.setUnread(r.value) }; _state.update { it.copy(unread = r.value) } }
                is ApiResult.Failure -> {
                    _state.update { s -> s.copy(alerts = s.alerts.map { if (it.id in was) it.copy(read = false) else it }, error = "Couldn't mark read") }
                    if (was.isNotEmpty()) badge.set(badge.value + was.size)
                }
            }
        }
    }

    fun markAllRead() {
        val s = _state.value
        val was = s.alerts.filter { !it.read }.map { it.id }
        val badgeWas = badge.value
        _state.update { st -> st.copy(alerts = st.alerts.map { it.copy(read = true) }, error = null) }
        if (s.store == null) badge.set(0) else badge.set(badge.value - was.size)
        onRead(was)
        scope.launch {
            when (val r = remote.markAllRead(s.store)) {
                is ApiResult.Success -> { badge.set(r.value); runCatching { check.setUnread(r.value) }; _state.update { it.copy(unread = r.value) } }
                is ApiResult.Failure -> {
                    _state.update { st -> st.copy(alerts = st.alerts.map { if (it.id in was) it.copy(read = false) else it }, error = "Couldn't mark read") }
                    badge.set(badgeWas)
                }
            }
        }
    }

    private fun statusOf(e: ApiError) = when (e) {
        ApiError.Offline -> FeedStatus.Offline
        ApiError.NotConfigured -> FeedStatus.NotConfigured
        ApiError.Unauthorized, ApiError.Forbidden -> FeedStatus.SignedOut
        else -> FeedStatus.Error
    }
}
