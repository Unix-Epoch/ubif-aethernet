package dev.aethernet.linkpearl.feature.widget

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.aethernet.linkpearl.core.data.EncryptedFile
import dev.aethernet.linkpearl.core.data.HomeData
import dev.aethernet.linkpearl.core.data.HomeRepository
import dev.aethernet.linkpearl.core.data.HomeResult
import dev.aethernet.linkpearl.core.data.LinkpearlJson
import dev.aethernet.linkpearl.core.data.StoreScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer

/** Which store each placed widget shows (by app widget id). A widget with no choice shows Home's current store. */
interface WidgetConfig {
    fun scopeKey(appWidgetId: Int): Flow<String?>
    suspend fun set(appWidgetId: Int, scope: StoreScope)
    suspend fun remove(appWidgetIds: IntArray)
}

private val Context.widgetDataStore: DataStore<Preferences> by preferencesDataStore(name = "widgets")
private fun keyFor(id: Int) = stringPreferencesKey("w$id")

class DataStoreWidgetConfig(private val context: Context) : WidgetConfig {
    override fun scopeKey(appWidgetId: Int): Flow<String?> = context.widgetDataStore.data.map { it[keyFor(appWidgetId)] }
    override suspend fun set(appWidgetId: Int, scope: StoreScope) { context.widgetDataStore.edit { it[keyFor(appWidgetId)] = scope.key } }
    override suspend fun remove(appWidgetIds: IntArray) { context.widgetDataStore.edit { p -> appWidgetIds.forEach { p.remove(keyFor(it)) } } }
}

class MemoryWidgetConfig(initial: Map<Int, String> = emptyMap()) : WidgetConfig {
    private val map = MutableStateFlow(initial)
    override fun scopeKey(appWidgetId: Int): Flow<String?> = map.map { it[appWidgetId] }
    override suspend fun set(appWidgetId: Int, scope: StoreScope) = map.update { it + (appWidgetId to scope.key) }
    override suspend fun remove(appWidgetIds: IntArray) = map.update { it - appWidgetIds.toSet() }
}

/** The saved snapshots by scope key, in memory and (when [file] is given) encrypted on disk like Home's own cache. */
class WidgetSnapshots(private val file: EncryptedFile? = null) {
    private val serializer = MapSerializer(String.serializer(), WidgetSnapshot.serializer())
    private val _all = MutableStateFlow<Map<String, WidgetSnapshot>>(emptyMap())
    val all: StateFlow<Map<String, WidgetSnapshot>> = _all.asStateFlow()
    private val lock = Mutex()
    private var loaded = file == null

    suspend fun load() = lock.withLock {
        if (loaded) return@withLock
        val saved = withContext(Dispatchers.IO) { runCatching { file?.read()?.let { LinkpearlJson.decodeFromString(serializer, it.decodeToString()) } }.getOrNull() }
        if (saved != null) _all.update { saved + it }
        loaded = true
    }

    suspend fun put(snapshot: WidgetSnapshot) {
        load()
        lock.withLock {
            _all.update { it + (snapshot.scope to snapshot) }
            write()
        }
    }

    suspend fun clear() = lock.withLock {
        _all.value = emptyMap()
        loaded = true
        withContext(Dispatchers.IO) { runCatching { file?.delete() } }
    }

    private suspend fun write() {
        val f = file ?: return
        val bytes = LinkpearlJson.encodeToString(serializer, _all.value).toByteArray()
        withContext(Dispatchers.IO) { runCatching { f.write(bytes) } }
    }
}

/** The placed widgets as the launcher knows them. Real: [GlanceWidgetHosts]. */
interface WidgetHosts {
    suspend fun appWidgetIds(): List<Int>
    /** Redraws every placed widget from the saved snapshots. */
    suspend fun redraw()
}

/**
 * Keeps the widgets' snapshots current: the periodic job fetches every scope a widget shows ([refreshAll]); a Home fetch in the app
 * saves its answer for widgets that show the same scope ([onHome]). Signing out clears everything ([clear]).
 */
class WidgetRefresher(
    private val hosts: WidgetHosts,
    private val home: HomeRepository,
    private val config: WidgetConfig,
    val snapshots: WidgetSnapshots,
    private val homeScope: Flow<StoreScope>,
    private val scope: CoroutineScope,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val minFetchGapMs: Long = 5 * 60_000L,
    /** False while the phone is not signed in: widgets then show no numbers, whatever is saved. */
    private val signedIn: Flow<Boolean> = kotlinx.coroutines.flow.flowOf(true),
) {
    private val fetching = Mutex()
    private var lastFetchMs = 0L

    /** The snapshot one widget shows: its chosen store, else Home's current store. */
    fun snapshotFor(appWidgetId: Int): Flow<WidgetSnapshot?> =
        combine(config.scopeKey(appWidgetId), homeScope, snapshots.all, signedIn) { key, homeScope, all, on -> if (on) all[key ?: homeScope.key] else null }

    suspend fun scopesInUse(): Set<String> {
        val ids = hosts.appWidgetIds()
        if (ids.isEmpty()) return emptySet()
        val fallback = homeScope.first().key
        return ids.map { config.scopeKey(it).first() ?: fallback }.toSet()
    }

    /**
     * Fetches Home for each scope a widget shows (offline: the phone's last copy) and redraws. [force] = the periodic job (otherwise
     * a fetch less than a few minutes after the last one is skipped and only the redraw happens). Returns false when there are no widgets.
     */
    suspend fun refreshAll(force: Boolean = true): Boolean {
        snapshots.load()
        val scopes = scopesInUse()
        if (scopes.isEmpty()) return false
        fetching.withLock {
            if (force || nowMs() - lastFetchMs >= minFetchGapMs) {
                lastFetchMs = nowMs()
                scopes.forEach { key ->
                    val s = StoreScope.fromKey(key)
                    val r = home.load(s)
                    if (r is HomeResult.Ok && !r.data.empty) snapshots.put(WidgetSnapshot.from(s, r.data))
                }
            }
        }
        hosts.redraw()
        return true
    }

    /** The app fetched Home for [s]: save it when a widget shows that scope, and redraw. */
    fun onHome(s: StoreScope, data: HomeData) {
        if (data.empty) return
        scope.launch {
            runCatching {
                if (s.key !in scopesInUse()) return@runCatching
                snapshots.put(WidgetSnapshot.from(s, data))
                hosts.redraw()
            }
        }
    }

    suspend fun clear() {
        snapshots.clear()
        runCatching { hosts.redraw() }
    }
}

/** Home as the app sees it, telling the widgets about every answer (fresh or the phone's copy). */
class WidgetFeedingHomeRepository(private val inner: HomeRepository, private val onAnswer: (StoreScope, HomeData) -> Unit) : HomeRepository {
    override suspend fun load(scope: StoreScope, fresh: Boolean): HomeResult =
        inner.load(scope, fresh).also { r -> if (r is HomeResult.Ok) runCatching { onAnswer(scope, r.data) } }
}
