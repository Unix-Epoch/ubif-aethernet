package dev.aethernet.linkpearl.feature.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import androidx.core.net.toUri
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.glance.GlanceId
import androidx.glance.action.Action
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.updateAll
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerFactory
import androidx.work.WorkerParameters
import dev.aethernet.linkpearl.LinkpearlApp
import dev.aethernet.linkpearl.MainActivity
import dev.aethernet.linkpearl.core.nav.Routes
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit

private fun Context.refresher(): WidgetRefresher? = runCatching { (applicationContext as LinkpearlApp).container.get<WidgetRefresher>() }.getOrNull()

/** A tap opens the app on Home (the `linkpearl://home` link, so a running app goes to Home too). */
internal fun openHome(context: Context): Action =
    actionStartActivity(Intent(Intent.ACTION_VIEW, Routes.deepLink(Routes.HOME).toUri(), context, MainActivity::class.java))

/** Draws one widget from its saved snapshot and redraws when the snapshot changes while the widget's session is open. */
abstract class SnapshotWidget : GlanceAppWidget() {
    abstract fun draw(): @androidx.compose.runtime.Composable (WidgetUi, Action) -> Unit

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val refresher = context.refresher()
        val appWidgetId = GlanceAppWidgetManager(context).getAppWidgetId(id)
        refresher?.snapshots?.load()
        val body = draw()
        val tap = openHome(context)
        provideContent {
            val flow = androidx.compose.runtime.remember(appWidgetId) { refresher?.snapshotFor(appWidgetId) ?: kotlinx.coroutines.flow.flowOf(null) }
            val snap by flow.collectAsState(null)
            body(WidgetUi.from(snap), tap)
        }
    }
}

/** "Linkpearl": store, as-of time, today's sales with the week, sales per labor hour, RFP total, open work orders. */
class LinkpearlWidget : SnapshotWidget() {
    override val sizeMode = SizeMode.Responsive(WidgetSizes.linkpearl)
    override fun draw(): @androidx.compose.runtime.Composable (WidgetUi, Action) -> Unit = { ui, tap -> LinkpearlWidgetContent(ui, tap) }
}

/** "Today's sales": the figure and Yesterday. */
class SalesWidget : SnapshotWidget() {
    override val sizeMode = SizeMode.Responsive(WidgetSizes.sales)
    override fun draw(): @androidx.compose.runtime.Composable (WidgetUi, Action) -> Unit = { ui, tap -> SalesWidgetContent(ui, tap) }
}

/** Shared receiver behaviour: forget a removed widget's store choice; start the 30-minute job with the first widget, stop it with the last. */
abstract class SnapshotWidgetReceiver : GlanceAppWidgetReceiver() {
    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        super.onUpdate(context, appWidgetManager, appWidgetIds)
        WidgetScheduler.schedule(context)
        val app = context.applicationContext as? LinkpearlApp ?: return
        app.container.appScope.launch { runCatching { context.refresher()?.refreshAll(force = false) } }
    }

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        super.onDeleted(context, appWidgetIds)
        val app = context.applicationContext as? LinkpearlApp ?: return
        app.container.appScope.launch { runCatching { app.container.get<WidgetConfig>().remove(appWidgetIds) } }
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        val app = context.applicationContext as? LinkpearlApp ?: return
        app.container.appScope.launch { if (runCatching { GlanceWidgetHosts(context).appWidgetIds().isEmpty() }.getOrDefault(true)) WidgetScheduler.cancel(context) }
    }
}

class LinkpearlWidgetReceiver : SnapshotWidgetReceiver() { override val glanceAppWidget: GlanceAppWidget = LinkpearlWidget() }
class SalesWidgetReceiver : SnapshotWidgetReceiver() { override val glanceAppWidget: GlanceAppWidget = SalesWidget() }

class GlanceWidgetHosts(private val context: Context) : WidgetHosts {
    override suspend fun appWidgetIds(): List<Int> {
        val m = GlanceAppWidgetManager(context)
        return (m.getGlanceIds(LinkpearlWidget::class.java) + m.getGlanceIds(SalesWidget::class.java)).map { m.getAppWidgetId(it) }
    }

    override suspend fun redraw() {
        LinkpearlWidget().updateAll(context)
        SalesWidget().updateAll(context)
    }
}

/** The 30-minute job: fetch Home for each store a widget shows and redraw. Stops itself when no widget is left. */
class WidgetWorker(context: Context, params: WorkerParameters, private val refresher: () -> WidgetRefresher) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = try {
        if (!refresher().refreshAll(force = true)) WidgetScheduler.cancel(applicationContext)
        Result.success()
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (_: Exception) {
        if (runAttemptCount < 3) Result.retry() else Result.success()
    }
}

class WidgetWorkerFactory(private val refresher: () -> WidgetRefresher) : WorkerFactory() {
    override fun createWorker(appContext: Context, workerClassName: String, workerParameters: WorkerParameters) =
        if (workerClassName == WidgetWorker::class.java.name) WidgetWorker(appContext, workerParameters, refresher) else null
}

object WidgetScheduler {
    const val UNIQUE_NAME = "linkpearl-widgets"

    fun schedule(context: Context) {
        val request = PeriodicWorkRequestBuilder<WidgetWorker>(30, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 5, TimeUnit.MINUTES)
            .build()
        runCatching { WorkManager.getInstance(context).enqueueUniquePeriodicWork(UNIQUE_NAME, ExistingPeriodicWorkPolicy.UPDATE, request) }
    }

    fun cancel(context: Context) {
        runCatching { WorkManager.getInstance(context).cancelUniqueWork(UNIQUE_NAME) }
    }
}
