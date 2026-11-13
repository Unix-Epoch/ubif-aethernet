package dev.aethernet.linkpearl.feature.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.data.Auth
import dev.aethernet.linkpearl.core.data.AuthState
import dev.aethernet.linkpearl.core.data.StoreZone
import dev.aethernet.linkpearl.core.design.Fmt
import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.lock.AppLock
import dev.aethernet.linkpearl.core.lock.LOCK_IDLE_TIMEOUT
import dev.aethernet.linkpearl.core.prefs.AppPrefs
import dev.aethernet.linkpearl.core.prefs.Appearance
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** One store on the Device card. [updated] is the formatted last-update time, a dash when the server has none, null when it could not be fetched. */
data class StoreLine(val id: Int, val label: String, val updated: String?)

/** What the notification control does when tapped. */
enum class NotificationAction { RequestPermission, OpenSettings }

/**
 * Android 13+ shows the permission dialog until the user has answered it once; after that (or below Android 13, where there is
 * no permission dialog) only the app's notification settings page can change it.
 */
fun notificationAction(sdkInt: Int, alreadyAsked: Boolean): NotificationAction =
    if (sdkInt >= 33 && !alreadyAsked) NotificationAction.RequestPermission else NotificationAction.OpenSettings

data class SettingsUiState(
    val phoneName: String? = null,
    val stores: List<StoreLine> = emptyList(),
    val unlocked: Boolean = false,
    val lockAfter: String = lockAfterLabel(),
    val notificationsOn: Boolean = false,
    val appearance: Appearance = Appearance.Dark,
    val confirmForget: Boolean = false,
    val forgetting: Boolean = false,
)

fun lockAfterLabel(): String = LOCK_IDLE_TIMEOUT.inWholeMinutes.let { if (it == 1L) "1 minute" else "$it minutes" }

class SettingsViewModel(
    private val auth: Auth,
    private val lock: AppLock,
    private val prefs: AppPrefs,
    private val api: ApiClient,
    private val tz: String = STORE_TZ,
) : ViewModel() {
    private val local = MutableStateFlow(SettingsUiState())
    private val lastScans = MutableStateFlow<Map<Int, String?>?>(null)
    private val notificationsOn = MutableStateFlow(false)

    val state: StateFlow<SettingsUiState> = combine(
        auth.state, lock.isUnlocked, prefs.appearance, lastScans, notificationsOn,
    ) { a, unlocked, appearance, scans, notif ->
        val reg = a as? AuthState.Registered
        SettingsUiState(
            phoneName = reg?.name,
            stores = reg?.stores.orEmpty().map { StoreLine(it.id, Fmt.storeLabel(it.id, it.name), scans?.let { s -> Fmt.clock(s[it.id], tz) }) },
            unlocked = unlocked, notificationsOn = notif, appearance = appearance,
        )
    }.combine(local) { s, l -> s.copy(confirmForget = l.confirmForget, forgetting = l.forgetting) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, SettingsUiState())

    init { refresh() }

    /** Loads each store's last update time (one small request); the names are shown either way. */
    fun refresh() {
        viewModelScope.launch {
            val r = api.get("/v1/agents/m/prefs")
            if (r is ApiResult.Success) lastScans.value = parseScans(r.value as? JsonObject)
        }
    }

    fun toggleLock() { if (lock.isUnlocked.value) lock.lock() else lock.unlock() }

    /** The screen reports the system state (permission and the app's notification switch) whenever it comes back to the front. */
    fun onNotificationsChecked(enabled: Boolean) { notificationsOn.value = enabled }

    /** Tapping the notification control; the screen performs the returned action. */
    fun onNotificationsTapped(sdkInt: Int, alreadyAsked: Boolean): NotificationAction {
        val a = notificationAction(sdkInt, alreadyAsked)
        if (a == NotificationAction.RequestPermission) viewModelScope.launch { prefs.setNotificationsAsked(true) }
        return a
    }

    suspend fun notificationsAsked(): Boolean = prefs.notificationsAsked.first()

    fun setAppearance(value: Appearance) { viewModelScope.launch { prefs.setAppearance(value) } }

    fun askForget() = local.update { it.copy(confirmForget = true) }
    fun cancelForget() = local.update { it.copy(confirmForget = false) }

    /** Forgets this phone; Auth goes to Unregistered and the app shows onboarding. */
    fun confirmForget() {
        if (local.value.forgetting) return
        local.update { it.copy(confirmForget = false, forgetting = true) }
        viewModelScope.launch {
            try { auth.signOut() } finally { local.update { it.copy(forgetting = false) } }
        }
    }

    companion object {
        const val STORE_TZ = "America/New_York"

        internal fun parseScans(o: JsonObject?): Map<Int, String?> =
            (o?.get("stores") as? JsonArray).orEmpty().mapNotNull { e ->
                val s = e.jsonObject
                val id = s["id"]?.jsonPrimitive?.intOrNull ?: return@mapNotNull null
                id to s["lastScanAt"]?.jsonPrimitive?.contentOrNull
            }.toMap()

        fun factory(c: AppContainer): ViewModelProvider.Factory = viewModelFactory {
            initializer { SettingsViewModel(c.get(), c.get(), c.get(), c.get(), tz = runCatching { c.get<StoreZone>().id }.getOrDefault(STORE_TZ)) }
        }
    }
}
