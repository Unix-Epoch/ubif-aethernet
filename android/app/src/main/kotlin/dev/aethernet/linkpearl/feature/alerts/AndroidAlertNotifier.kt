package dev.aethernet.linkpearl.feature.alerts

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import dev.aethernet.linkpearl.R
import dev.aethernet.linkpearl.core.nav.Routes

/**
 * Channels per type (so the owner can silence one in Android's settings), a group per store with an inbox summary, and a tap that opens
 * the work order (`linkpearl://workorders/{store}-{wo}`) or the Alerts screen. Titles are the store, text is the sentence: nothing else.
 */
class AndroidAlertNotifier(private val context: Context) : AlertNotifier {
    private val nm = NotificationManagerCompat.from(context)

    override fun canNotify(): Boolean = nm.areNotificationsEnabled()

    override fun post(notes: List<PlannedNote>): Boolean {
        if (!canNotify()) return false
        return try {
            notes.forEach { nm.notify(TAG, it.id, build(it)) }
            notes.map { it.store }.distinct().forEach { updateSummary(it) }
            true
        } catch (_: SecurityException) { false }
    }

    override fun cancel(alertIds: List<Int>) {
        alertIds.forEach { nm.cancel(TAG, it) }
        // A collapsed note carries several ids under its lowest one; the receiver cancels by every id, which is harmless for the rest.
    }

    private fun intentFor(uri: String) = Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setPackage(context.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)

    private fun tap(note: PlannedNote): PendingIntent {
        val uri = note.workOrder?.let { Routes.deepLink(Routes.workOrder(note.store, it)) } ?: Routes.deepLink(Routes.ALERTS)
        return PendingIntent.getActivity(context, note.id, intentFor(uri), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun build(note: PlannedNote): Notification {
        val b = NotificationCompat.Builder(context, note.type.channelId!!)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setContentTitle(note.title).setContentText(note.text)
            .setGroup(groupKey(note.store)).setAutoCancel(true).setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setContentIntent(tap(note))
        markReadAction(note.alertIds)?.let { b.addAction(0, "Mark read", it) }
        return b.build()
    }

    /** The "Mark read" action needs the receiver declared in the manifest; without it the button is left out rather than doing nothing. */
    private fun markReadAction(ids: List<Int>): PendingIntent? {
        val intent = Intent(AlertActionReceiver.ACTION_MARK_READ).setClass(context, AlertActionReceiver::class.java)
            .putExtra(AlertActionReceiver.EXTRA_IDS, ids.toIntArray())
        if (context.packageManager.queryBroadcastReceivers(intent, 0).isEmpty()) return null
        return PendingIntent.getBroadcast(context, ids.first(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun groupKey(store: Int) = "store-$store"

    private fun updateSummary(store: Int) {
        val svc = context.getSystemService(NotificationManager::class.java)
        val key = groupKey(store)
        val members = svc.activeNotifications.filter { it.tag == TAG && it.notification.group == key }
        val id = SUMMARY_BASE + store
        if (members.size < 2) { nm.cancel(SUMMARY_TAG, id); return }
        val lines = members.sortedByDescending { it.postTime }.mapNotNull { it.notification.extras.getCharSequence(Notification.EXTRA_TEXT) }
        val style = NotificationCompat.InboxStyle().also { s -> lines.take(5).forEach(s::addLine); s.setSummaryText("${lines.size} alerts") }
        val channel = members.first().notification.channelId
        val n = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_launcher_monochrome).setStyle(style)
            .setContentTitle(members.first().notification.extras.getCharSequence(Notification.EXTRA_TITLE))
            .setContentText("${lines.size} alerts")
            .setGroup(key).setGroupSummary(true).setAutoCancel(true)
            .setContentIntent(PendingIntent.getActivity(context, id, intentFor(Routes.deepLink(Routes.ALERTS)), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .build()
        nm.notify(SUMMARY_TAG, id, n)
    }

    companion object {
        const val TAG = "alert"
        const val SUMMARY_TAG = "alert-summary"
        const val SUMMARY_BASE = 2_000_000
    }
}
