package dev.aethernet.linkpearl.feature.alerts

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerFactory
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/** The periodic job: everything happens in [AlertChecker]. Never throws; failures are results. */
class AlertsWorker(context: Context, params: WorkerParameters, private val hub: () -> AlertsHub) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = try {
        when (hub().checker.run(runAttemptCount)) {
            CheckOutcome.Done -> Result.success()
            CheckOutcome.Retry -> Result.retry()
        }
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (_: Exception) {
        if (runAttemptCount < AlertChecker.MAX_RETRIES) Result.retry() else Result.success()
    }
}

class AlertsWorkerFactory(private val hub: () -> AlertsHub) : WorkerFactory() {
    override fun createWorker(appContext: Context, workerClassName: String, workerParameters: WorkerParameters) =
        if (workerClassName == AlertsWorker::class.java.name) AlertsWorker(appContext, workerParameters, hub) else null
}

/** The one unique periodic job. WorkManager persists it across reboots and app updates and reschedules it itself. */
object AlertsScheduler {
    const val UNIQUE_NAME = "linkpearl-alerts-check"

    fun schedule(context: Context) {
        val request = PeriodicWorkRequestBuilder<AlertsWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 5, TimeUnit.MINUTES)
            .build()
        // UPDATE keeps the current period timing and swaps in the new definition after an app update.
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(UNIQUE_NAME, ExistingPeriodicWorkPolicy.UPDATE, request)
    }

    fun cancel(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(UNIQUE_NAME)
    }
}
