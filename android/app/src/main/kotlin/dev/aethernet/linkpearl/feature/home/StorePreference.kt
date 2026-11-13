package dev.aethernet.linkpearl.feature.home

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.aethernet.linkpearl.core.data.StoreScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map

/** The remembered store choice on Home ("all" or a store id). */
interface StorePreference {
    val scope: Flow<StoreScope>
    suspend fun set(scope: StoreScope)
}

private val Context.homeDataStore: DataStore<Preferences> by preferencesDataStore(name = "home")
private val KEY_STORE = stringPreferencesKey("store")

class DataStoreStorePreference(private val context: Context) : StorePreference {
    override val scope: Flow<StoreScope> = context.homeDataStore.data.map { StoreScope.fromKey(it[KEY_STORE]) }
    override suspend fun set(scope: StoreScope) { context.homeDataStore.edit { it[KEY_STORE] = scope.key } }
}

/** In-memory preference for tests and previews. */
class MemoryStorePreference(initial: StoreScope = StoreScope.All) : StorePreference {
    private val state = MutableStateFlow(initial)
    override val scope: Flow<StoreScope> = state
    override suspend fun set(scope: StoreScope) { state.value = scope }
}
