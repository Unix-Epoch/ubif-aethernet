package dev.aethernet.linkpearl.feature.alerts

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.aethernet.linkpearl.LinkpearlApp
import kotlinx.coroutines.launch

/**
 * The notification's "Mark read" action. Needs `<receiver android:name=".feature.alerts.AlertActionReceiver" android:exported="false" />`
 * in the manifest (shared file: requested in the report); until then the action is not shown.
 */
class AlertActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_MARK_READ) return
        val ids = intent.getIntArrayExtra(EXTRA_IDS)?.toList().orEmpty()
        if (ids.isEmpty()) return
        val container = (context.applicationContext as? LinkpearlApp)?.container ?: return
        val pending = goAsync()
        container.appScope.launch {
            try { container.get<AlertsHub>().feed.markRead(ids) } finally { pending.finish() }
        }
    }

    companion object {
        const val ACTION_MARK_READ = "dev.aethernet.linkpearl.alerts.MARK_READ"
        const val EXTRA_IDS = "ids"
    }
}
