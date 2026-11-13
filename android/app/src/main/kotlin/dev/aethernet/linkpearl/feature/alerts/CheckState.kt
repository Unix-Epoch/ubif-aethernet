package dev.aethernet.linkpearl.feature.alerts

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * What the background check remembers between runs: the cursor, when it last ran, the last unread count (so the badge is right at
 * start), and how often the notification permission was asked. No alert content is ever stored.
 */
interface CheckState {
    suspend fun cursor(): Int?
    suspend fun setCursor(v: Int)
    suspend fun lastCheck(): Long?
    suspend fun setLastCheck(ms: Long)
    suspend fun unread(): Int?
    suspend fun setUnread(v: Int)
    suspend fun permissionAsks(): Int
    suspend fun setPermissionAsks(v: Int)
    /** Sign-out: forget everything that belongs to the old identity. */
    suspend fun clear()
}

private val Context.alertsStore by preferencesDataStore("linkpearl_alerts")

class DataStoreCheckState(context: Context) : CheckState {
    private val ds = context.applicationContext.alertsStore
    private val cursorKey = intPreferencesKey("cursor")
    private val lastKey = longPreferencesKey("last_check_ms")
    private val unreadKey = intPreferencesKey("unread")
    private val asksKey = intPreferencesKey("permission_asks")

    private suspend fun <T> read(f: (Preferences) -> T): T = ds.data.map(f).first()

    override suspend fun cursor() = read { it[cursorKey] }
    override suspend fun setCursor(v: Int) { ds.edit { it[cursorKey] = v } }
    override suspend fun lastCheck() = read { it[lastKey] }
    override suspend fun setLastCheck(ms: Long) { ds.edit { it[lastKey] = ms } }
    override suspend fun unread() = read { it[unreadKey] }
    override suspend fun setUnread(v: Int) { ds.edit { it[unreadKey] = v } }
    override suspend fun permissionAsks() = read { it[asksKey] ?: 0 }
    override suspend fun setPermissionAsks(v: Int) { ds.edit { it[asksKey] = v } }
    override suspend fun clear() { ds.edit { it.remove(cursorKey); it.remove(lastKey); it.remove(unreadKey) } }
}
