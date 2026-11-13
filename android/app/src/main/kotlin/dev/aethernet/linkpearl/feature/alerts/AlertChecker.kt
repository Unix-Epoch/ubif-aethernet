package dev.aethernet.linkpearl.feature.alerts

import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult

enum class CheckOutcome {
    /** Finished (or stopped quietly): wait for the next period. */
    Done,
    /** A transient failure: let WorkManager back off and try again. */
    Retry,
}

/**
 * The background check, as a plain class so it is tested on the JVM; the worker only delegates here.
 *
 * Cursor rules:
 *  - first run (no stored cursor): ask without `since`, store the answer, notify about nothing;
 *  - `held` (quiet hours): keep the cursor;
 *  - entries are notified first, and only then is the cursor stored (a failed or refused post leaves it where it was, so nothing is lost
 *    and a repeat poll can only replace a notification, never duplicate it: the notification identity is the alert id);
 *  - notifications not allowed: entries are not skipped, the cursor stays (the server stops returning them after 12 hours);
 *  - `more`: poll again straight away, up to [maxPages] times.
 */
class AlertChecker(
    private val remote: AlertsRemote,
    private val state: CheckState,
    private val notifier: AlertNotifier,
    private val storeNames: () -> Map<Int, String>,
    private val refreshAuth: suspend () -> Unit,
    private val onUnread: suspend (Int) -> Unit,
    private val now: () -> Long = System::currentTimeMillis,
    private val maxPages: Int = 10,
) {
    suspend fun run(attempt: Int = 0): CheckOutcome {
        val outcome = poll(attempt)
        state.setLastCheck(now())
        if (outcome == CheckOutcome.Done) refreshBadge()
        return outcome
    }

    private suspend fun poll(attempt: Int): CheckOutcome {
        var cursor = state.cursor()
        if (cursor == null) {
            return when (val r = remote.poll(null)) {
                is ApiResult.Success -> { state.setCursor(r.value.cursor); CheckOutcome.Done }
                is ApiResult.Failure -> failure(r.error, attempt)
            }
        }
        repeat(maxPages) {
            when (val r = remote.poll(cursor)) {
                is ApiResult.Failure -> return failure(r.error, attempt)
                is ApiResult.Success -> {
                    val p = r.value
                    if (p.held) return CheckOutcome.Done
                    if (p.alerts.isNotEmpty()) {
                        if (!notifier.canNotify()) return CheckOutcome.Done
                        if (!notifier.post(NotificationPlanner.plan(p.alerts, storeNames()))) return CheckOutcome.Done
                    }
                    if (p.cursor != cursor) { state.setCursor(p.cursor); cursor = p.cursor }
                    if (!p.more) return CheckOutcome.Done
                }
            }
        }
        return CheckOutcome.Done
    }

    private suspend fun failure(e: ApiError, attempt: Int): CheckOutcome = when (e) {
        ApiError.Unauthorized, ApiError.Forbidden -> { runCatching { refreshAuth() }; CheckOutcome.Done }
        ApiError.Offline, ApiError.Server -> if (attempt < MAX_RETRIES) CheckOutcome.Retry else CheckOutcome.Done
        ApiError.NotConfigured, ApiError.NotFound, ApiError.RateLimited -> CheckOutcome.Done
    }

    /** Keeps the Alerts tab badge right even when nothing could be notified. */
    private suspend fun refreshBadge() {
        val r = remote.feed(limit = 1)
        if (r is ApiResult.Success) onUnread(r.value.unread)
    }

    companion object { const val MAX_RETRIES = 3 }
}
