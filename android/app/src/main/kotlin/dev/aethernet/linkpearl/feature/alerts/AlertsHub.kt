package dev.aethernet.linkpearl.feature.alerts

import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.data.Auth
import dev.aethernet.linkpearl.core.data.AuthState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

private fun namesOf(s: AuthState): Map<Int, String> =
    (s as? AuthState.Registered)?.stores?.mapNotNull { st -> st.name?.takeIf { it.isNotBlank() }?.let { st.id to it } }?.toMap() ?: emptyMap()

/** Everything the alerts feature shares across the screen, the worker, the notification action and the nav badge. */
class AlertsHub(
    api: ApiClient,
    val auth: Auth,
    val check: CheckState,
    val notifier: AlertNotifier,
    private val scope: CoroutineScope,
) {
    val remote = AlertsRemote(api)
    val badge = AlertsBadges(0, scope)
    val storeNames: StateFlow<Map<Int, String>> = auth.state.map(::namesOf).stateIn(scope, SharingStarted.Eagerly, namesOf(auth.state.value))
    val storeIds: StateFlow<List<Int>> = auth.state.map { s -> (s as? AuthState.Registered)?.stores?.map { it.id } ?: emptyList() }
        .stateIn(scope, SharingStarted.Eagerly, (auth.state.value as? AuthState.Registered)?.stores?.map { it.id } ?: emptyList())
    val feed = AlertsFeed(remote, scope, badge, check, onRead = notifier::cancel)
    val settings = AlertSettingsController(remote, scope)
    val checker = AlertChecker(
        remote, check, notifier, storeNames = { storeNames.value }, refreshAuth = { auth.refresh() },
        onUnread = { badge.set(it); check.setUnread(it) },
    )

    private val _notificationsOn = MutableStateFlow(notifier.canNotify())
    /** Whether Android will show this app's notifications right now (checked again whenever the app comes back). */
    val notificationsOn: StateFlow<Boolean> = _notificationsOn.asStateFlow()

    init {
        scope.launch { check.unread()?.let { if (badge.value == 0) badge.set(it) } }
    }

    fun refreshNotificationState() { _notificationsOn.value = notifier.canNotify() }

    /** The app came to the foreground: refresh the feed quietly (badge and list); the worker keeps sole charge of notifying. */
    fun onForeground() {
        refreshNotificationState()
        if (auth.state.value is AuthState.Registered) feed.refresh(seen = false)
    }

    suspend fun noteAskedForPermission() { check.setPermissionAsks(check.permissionAsks() + 1) }
}
