package dev.aethernet.linkpearl.core.prefs

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.FeatureModule
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import dev.aethernet.linkpearl.core.lock.CapturePolicy
import kotlinx.coroutines.runBlocking

/** Dark, Light, or follow the phone's own setting. Dark is the default (the app's primary theme). */
enum class Appearance(val key: String) {
    Dark("dark"), Light("light"), System("system");

    /** Whether the dark colours apply, given what the phone itself is set to. */
    fun isDark(systemDark: Boolean): Boolean = when (this) { Dark -> true; Light -> false; System -> systemDark }

    companion object {
        fun fromKey(key: String?): Appearance = entries.firstOrNull { it.key == key } ?: Dark
    }
}

/**
 * App-wide preferences (Settings owns them; any feature may read them). Backed by DataStore; [MemoryAppPrefs] for tests.
 * Add a new preference as one more flow plus one setter here.
 */
interface AppPrefs {
    val appearance: Flow<Appearance>
    suspend fun setAppearance(value: Appearance)

    /** True once the notification permission dialog has been shown (after that the system will not show it again: Settings opens the app's notification page instead). */
    val notificationsAsked: Flow<Boolean>
    suspend fun setNotificationsAsked(value: Boolean)

    /** Download and install new versions on their own (on by default). */
    val autoUpdate: Flow<Boolean>
    suspend fun setAutoUpdate(value: Boolean)

    /** Settings shows the Developer row (turned on by tapping Version seven times; off from the Developer screen). */
    val developer: Flow<Boolean>
    suspend fun setDeveloper(value: Boolean)

    /** Developer: leave screenshots and screen recording on while customer details are shown (no FLAG_SECURE). Off by default. */
    val allowCapture: Flow<Boolean>
    suspend fun setAllowCapture(value: Boolean)

    /** The stored appearance, read once and synchronously, for the first frame (a tiny local file; avoids a flash of the wrong theme at cold start). */
    fun appearanceNow(): Appearance = runBlocking { appearance.first() }
}

private val Context.appPrefsStore: DataStore<Preferences> by preferencesDataStore(name = "app_prefs")
private val KEY_APPEARANCE = stringPreferencesKey("appearance")
private val KEY_NOTIF_ASKED = booleanPreferencesKey("notifications_asked")
private val KEY_AUTO_UPDATE = booleanPreferencesKey("auto_update")
private val KEY_DEVELOPER = booleanPreferencesKey("developer")
private val KEY_ALLOW_CAPTURE = booleanPreferencesKey("allow_capture")

class DataStoreAppPrefs(private val context: Context) : AppPrefs {
    override val appearance: Flow<Appearance> = context.appPrefsStore.data.map { Appearance.fromKey(it[KEY_APPEARANCE]) }
    override suspend fun setAppearance(value: Appearance) { context.appPrefsStore.edit { it[KEY_APPEARANCE] = value.key } }
    override val notificationsAsked: Flow<Boolean> = context.appPrefsStore.data.map { it[KEY_NOTIF_ASKED] ?: false }
    override suspend fun setNotificationsAsked(value: Boolean) { context.appPrefsStore.edit { it[KEY_NOTIF_ASKED] = value } }
    override val autoUpdate: Flow<Boolean> = context.appPrefsStore.data.map { it[KEY_AUTO_UPDATE] ?: true }
    override suspend fun setAutoUpdate(value: Boolean) { context.appPrefsStore.edit { it[KEY_AUTO_UPDATE] = value } }
    override val developer: Flow<Boolean> = context.appPrefsStore.data.map { it[KEY_DEVELOPER] ?: false }
    override suspend fun setDeveloper(value: Boolean) { context.appPrefsStore.edit { it[KEY_DEVELOPER] = value } }
    override val allowCapture: Flow<Boolean> = context.appPrefsStore.data.map { it[KEY_ALLOW_CAPTURE] ?: false }
    override suspend fun setAllowCapture(value: Boolean) { context.appPrefsStore.edit { it[KEY_ALLOW_CAPTURE] = value } }
}

/** In-memory preferences for tests and previews. */
class MemoryAppPrefs(
    appearance: Appearance = Appearance.Dark, asked: Boolean = false, autoUpdate: Boolean = true, developer: Boolean = false, allowCapture: Boolean = false,
) : AppPrefs {
    private val a = MutableStateFlow(appearance)
    private val n = MutableStateFlow(asked)
    private val u = MutableStateFlow(autoUpdate)
    private val d = MutableStateFlow(developer)
    private val cap = MutableStateFlow(allowCapture)
    override val appearance: Flow<Appearance> = a
    override suspend fun setAppearance(value: Appearance) { a.value = value }
    override val notificationsAsked: Flow<Boolean> = n
    override suspend fun setNotificationsAsked(value: Boolean) { n.value = value }
    override val autoUpdate: Flow<Boolean> = u
    override suspend fun setAutoUpdate(value: Boolean) { u.value = value }
    override val developer: Flow<Boolean> = d
    override suspend fun setDeveloper(value: Boolean) { d.value = value }
    override val allowCapture: Flow<Boolean> = cap
    override suspend fun setAllowCapture(value: Boolean) { cap.value = value }
    override fun appearanceNow(): Appearance = a.value
}

/** Provides [AppPrefs]; installed by SettingsModule, so it is not in the module list itself. */
object PrefsModule : FeatureModule {
    override fun install(c: AppContainer) {
        c.provide<AppPrefs> { DataStoreAppPrefs(c.application) }
        // SecureWindow reads the developer's capture switch from here, so screens (and their screenshot tests) need no container.
        c.appScope.launch { c.get<AppPrefs>().allowCapture.collect { CapturePolicy.allowed.value = it } }
    }
}
