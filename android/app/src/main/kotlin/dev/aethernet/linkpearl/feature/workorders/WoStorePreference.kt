package dev.aethernet.linkpearl.feature.workorders

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map

/** Work orders' own remembered store choice: null = all stores. Only a store number is stored (no customer data). */
interface WoStorePreference {
    val store: Flow<Int?>
    suspend fun set(store: Int?)
}

private val Context.woDataStore: DataStore<Preferences> by preferencesDataStore(name = "workorders")
private val KEY_STORE = stringPreferencesKey("store")

class DataStoreWoStorePreference(private val context: Context) : WoStorePreference {
    override val store: Flow<Int?> = context.woDataStore.data.map { it[KEY_STORE]?.toIntOrNull() }
    override suspend fun set(store: Int?) { context.woDataStore.edit { it[KEY_STORE] = store?.toString() ?: "all" } }
}

class MemoryWoStorePreference(initial: Int? = null) : WoStorePreference {
    private val state = MutableStateFlow(initial)
    override val store: Flow<Int?> = state
    override suspend fun set(store: Int?) { state.value = store }
}
