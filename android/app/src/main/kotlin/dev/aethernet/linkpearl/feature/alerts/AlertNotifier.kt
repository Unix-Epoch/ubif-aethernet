package dev.aethernet.linkpearl.feature.alerts

import dev.aethernet.linkpearl.core.nav.Routes

/** What to show for a batch of new alerts. Plain data so the grouping rules are tested on the JVM. */
data class PlannedNote(
    /** Lowest alert id it stands for; with the tag "alert" this is the notification's identity, so posting it twice replaces it. */
    val id: Int,
    val store: Int,
    val type: AlertType,
    val title: String,
    val text: String,
    val alertIds: List<Int>,
    /** The work order to open on tap (single work-order alerts only); null opens the Alerts screen. */
    val workOrder: Long?,
    /** Expanded text (BigTextStyle), one line each; empty for a one-sentence note. */
    val lines: List<String> = emptyList(),
) {
    /** Where a tap goes: the Morning digest screen, the work order, or Alerts. */
    val tapRoute: String
        get() = when {
            type == AlertType.Digest -> AlertsRoutes.digest(id)
            workOrder != null -> Routes.workOrder(store, workOrder)
            else -> Routes.ALERTS
        }
}

object NotificationPlanner {
    /**
     * One notification per alert, except that several alerts of one type for one store in the same batch collapse into one line
     * ("4 work orders stuck in a status"). Alerts that never notify (`back`) are dropped. Oldest first.
     */
    fun plan(alerts: List<Alert>, names: Map<Int, String>): List<PlannedNote> {
        val out = ArrayList<PlannedNote>()
        val sorted = alerts.filter { it.type.channelId != null }.sortedBy { it.id }
        sorted.groupBy { it.store to it.type }.values.sortedBy { it.first().id }.forEach { group ->
            val first = group.first()
            val title = AlertText.storeName(first.store, names)
            val collapsible = group.size >= 2 && (first.type == AlertType.Stuck || first.type == AlertType.Followup)
            if (collapsible) {
                val text = if (first.type == AlertType.Stuck) "${group.size} work orders stuck in a status" else "${group.size} follow-ups due today"
                out += PlannedNote(first.id, first.store, first.type, title, text, group.map { it.id }, null)
            } else group.forEach { a ->
                out += if (a.type == AlertType.Digest) digestNote(a)
                else PlannedNote(a.id, a.store, a.type, title, AlertText.sentence(a, names), listOf(a.id), a.wo)
            }
        }
        return out.sortedBy { it.id }
    }

    /** "Yesterday $2,096 · $168 per labor hour" over the digest's lines (zero lines left out); a tap opens the digest. */
    fun digestNote(a: Alert): PlannedNote {
        val d = a.digest ?: DigestFacts()
        val lines = DigestText.lines(d)
        return PlannedNote(a.id, a.store, a.type, DigestText.title(d), lines.firstOrNull() ?: AlertType.Digest.label, listOf(a.id), null, lines)
    }
}

/** Posts notifications. The Android implementation is [AndroidAlertNotifier]; tests use a recording fake. */
interface AlertNotifier {
    /** False when the system will not show notifications (permission not granted, or switched off for the app). */
    fun canNotify(): Boolean
    /** Posts the batch; false when it could not be posted (the cursor must then stay where it is). */
    fun post(notes: List<PlannedNote>): Boolean
    /** Removes the notifications of alerts that were read elsewhere. */
    fun cancel(alertIds: List<Int>)
}
