package dev.aethernet.linkpearl.feature.alerts

import android.content.Intent

/**
 * Opening a notification counts as reading it: the tap's intent carries the alert ids, and the activity marks them read once
 * (the extra is removed, so a recreated activity does not send it again).
 */
object NotificationTap {
    const val EXTRA_ALERT_IDS = "dev.aethernet.linkpearl.alerts.TAP_IDS"

    fun tag(intent: Intent, ids: List<Int>): Intent = if (ids.isEmpty()) intent else intent.putExtra(EXTRA_ALERT_IDS, ids.toIntArray())

    fun consume(intent: Intent?, markRead: (List<Int>) -> Unit) {
        val ids = intent?.getIntArrayExtra(EXTRA_ALERT_IDS)?.toList().orEmpty()
        intent?.removeExtra(EXTRA_ALERT_IDS)
        if (ids.isNotEmpty()) markRead(ids)
    }
}
