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

    /** The stored appearance, read once and synchronously, for the first frame (a tiny local file; avoids a flash of the wrong theme at cold start). */
    fun appearanceNow(): Appearance = runBlocking { appearance.first() }
}

private val Context.appPrefsStore: DataStore<Preferences> by preferencesDataStore(name = "app_prefs")
private val KEY_APPEARANCE = stringPreferencesKey("appearance")
private val KEY_NOTIF_ASKED = booleanPreferencesKey("notifications_asked")

class DataStoreAppPrefs(private val context: Context) : AppPrefs {
    override val appearance: Flow<Appearance> = context.appPrefsStore.data.map { Appearance.fromKey(it[KEY_APPEARANCE]) }
    override suspend fun setAppearance(value: Appearance) { context.appPrefsStore.edit { it[KEY_APPEARANCE] = value.key } }
    override val notificationsAsked: Flow<Boolean> = context.appPrefsStore.data.map { it[KEY_NOTIF_ASKED] ?: false }
    override suspend fun setNotificationsAsked(value: Boolean) { context.appPrefsStore.edit { it[KEY_NOTIF_ASKED] = value } }
}

/** In-memory preferences for tests and previews. */
class MemoryAppPrefs(appearance: Appearance = Appearance.Dark, asked: Boolean = false) : AppPrefs {
    private val a = MutableStateFlow(appearance)
    private val n = MutableStateFlow(asked)
    override val appearance: Flow<Appearance> = a
    override suspend fun setAppearance(value: Appearance) { a.value = value }
    override val notificationsAsked: Flow<Boolean> = n
    override suspend fun setNotificationsAsked(value: Boolean) { n.value = value }
    override fun appearanceNow(): Appearance = a.value
}

/** Provides [AppPrefs]; installed by SettingsModule (the one module list is not edited by feature agents). */
object PrefsModule : FeatureModule {
    override fun install(c: AppContainer) {
        c.provide<AppPrefs> { DataStoreAppPrefs(c.application) }
    }
}
