package dev.aethernet.linkpearl.feature.alerts

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import androidx.navigation.navDeepLink
import dev.aethernet.linkpearl.core.data.AuthState
import dev.aethernet.linkpearl.core.di.LocalAppContainer
import dev.aethernet.linkpearl.core.nav.LocalAdaptive
import dev.aethernet.linkpearl.core.nav.Routes
import kotlinx.coroutines.launch

/**
 * Alerts' destinations (agent C). Notifications open `linkpearl://alerts` or a work order (`linkpearl://workorders/{id}`).
 *
 * [navigate] opens a route inside the app's own back stack. AppNavHost does not pass one yet, so the fallback sends the route's deep link
 * to this app's own activity (back then returns to Home rather than to Alerts); passing `nav::navigate` here fixes that.
 */
fun NavGraphBuilder.alertsGraph(navigate: ((route: String) -> Unit)? = null) {
    composable(Routes.ALERTS, deepLinks = listOf(navDeepLink { uriPattern = Routes.deepLink(Routes.ALERTS) })) { AlertsRoute(navigate) }
    composable(Routes.ALERT_SETTINGS, deepLinks = listOf(navDeepLink { uriPattern = Routes.deepLink(Routes.ALERT_SETTINGS) })) { AlertSettingsRoute(onClose = null) }
}

private fun openRoute(context: Context, route: String) {
    context.startActivity(
        Intent(Intent.ACTION_VIEW, Uri.parse(Routes.deepLink(route))).setPackage(context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
    )
}

@Composable
private fun rememberHub(): AlertsHub {
    val container = LocalAppContainer.current
    return remember(container) { container.get<AlertsHub>() }
}

@Composable
fun AlertsRoute(navigate: ((String) -> Unit)? = null, modifier: Modifier = Modifier) {
    val hub = rememberHub()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val activity = LocalActivity.current
    val ui by hub.feed.state.collectAsStateWithLifecycle()
    val names by hub.storeNames.collectAsStateWithLifecycle()
    val storeIds by hub.storeIds.collectAsStateWithLifecycle()
    val settings by hub.settings.state.collectAsStateWithLifecycle()
    val notificationsOn by hub.notificationsOn.collectAsStateWithLifecycle()
    val auth by hub.auth.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var showSettings by remember { mutableStateOf(false) }

    // Opening the screen (and coming back to it) refreshes; the owner is looking, so the background cursor may move up to what is shown.
    LaunchedEffect(lifecycle, hub) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            hub.refreshNotificationState()
            hub.feed.refresh(seen = true)
            hub.settings.load()
        }
    }

    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { hub.refreshNotificationState() }
    val turnOn: () -> Unit = {
        scope.launch {
            val needsPermission = Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            val asks = hub.check.permissionAsks()
            // Android stops showing the dialog after two denials; then only the app's notification settings can turn it on.
            val canAsk = needsPermission && (asks == 0 || (activity != null && ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.POST_NOTIFICATIONS)))
            if (canAsk) { hub.noteAskedForPermission(); permission.launch(Manifest.permission.POST_NOTIFICATIONS) }
            else context.startActivity(
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }
    }

    val feedUi = if (auth is AuthState.Unregistered || auth is AuthState.Pending) ui.copy(status = FeedStatus.SignedOut) else ui

    if (showSettings) {
        BackHandler { showSettings = false }
        AlertSettingsRoute(onClose = { showSettings = false }, modifier = modifier)
        return
    }
    val actions = AlertsActions(
        onRefresh = { hub.feed.refresh(seen = true) }, onLoadMore = hub.feed::loadMore, onStore = hub.feed::setStore,
        onUnreadOnly = hub.feed::setUnreadOnly, onMarkAll = hub.feed::markAllRead, onMarkRead = { hub.feed.markRead(listOf(it)) },
        onOpenSettings = { showSettings = true }, onTurnOnNotifications = turnOn,
        onOpenWorkOrder = { wo -> val route = Routes.workOrder(wo.toString()); navigate?.invoke(route) ?: openRoute(context, route) },
        onEdit = { hub.settings.edit(it) },
    )
    AlertsContent(feedUi, names, storeIds, notificationsOn, settings, actions, modifier)
}

@Composable
fun AlertSettingsRoute(onClose: (() -> Unit)?, modifier: Modifier = Modifier) {
    val hub = rememberHub()
    val ui by hub.settings.state.collectAsStateWithLifecycle()
    val names by hub.storeNames.collectAsStateWithLifecycle()
    val storeIds by hub.storeIds.collectAsStateWithLifecycle()
    val back = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
    val compact = LocalAdaptive.current.isCompact
    LaunchedEffect(hub) { hub.settings.load() }
    AlertSettingsScreen(
        ui, names, storeIds, onEdit = { hub.settings.edit(it) }, onBack = onClose ?: { back?.onBackPressed(); Unit },
        onRetry = { hub.settings.load(force = true) }, modifier = modifier, editorStyle = if (compact) EditorStyle.Sheet else EditorStyle.Dialog,
    )
}
