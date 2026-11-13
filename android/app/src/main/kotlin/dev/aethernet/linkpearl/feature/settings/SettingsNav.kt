package dev.aethernet.linkpearl.feature.settings

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import androidx.navigation.navDeepLink
import dev.aethernet.linkpearl.core.di.LocalAppContainer
import dev.aethernet.linkpearl.core.nav.Routes
import kotlinx.coroutines.launch

const val ADMIN_SITE = "https://aethernet-admin.ubifaethernet.workers.dev/"

/**
 * Settings' destinations (agent D). [navigate] opens another route by its string (e.g. `alerts/settings`); the shell passes
 * `{ nav.navigate(it) }`. Without it Settings falls back to the route's `linkpearl://` deep link, which opens the same screen.
 */
fun NavGraphBuilder.settingsGraph(navigate: ((String) -> Unit)? = null) {
    composable(Routes.SETTINGS, deepLinks = listOf(navDeepLink { uriPattern = Routes.deepLink(Routes.SETTINGS) })) { SettingsRoute(navigate) }
}

@Composable
fun SettingsRoute(navigate: ((String) -> Unit)? = null, modifier: Modifier = Modifier) {
    val container = LocalAppContainer.current
    val context = LocalContext.current
    val vm: SettingsViewModel = viewModel(factory = SettingsViewModel.factory(container))
    val state by vm.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()

    fun check() = vm.onNotificationsChecked(NotificationManagerCompat.from(context).areNotificationsEnabled())
    val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { check() }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { check(); vm.refresh() }

    SettingsScreen(
        state, version = versionOf(context), modifier = modifier,
        actions = SettingsActions(
            onToggleLock = vm::toggleLock,
            onNotifications = {
                scope.launch {
                    when (vm.onNotificationsTapped(Build.VERSION.SDK_INT, vm.notificationsAsked())) {
                        NotificationAction.RequestPermission -> request.launch(Manifest.permission.POST_NOTIFICATIONS)
                        NotificationAction.OpenSettings -> context.startActivity(
                            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName),
                        )
                    }
                }
            },
            onAlertSettings = {
                if (navigate != null) navigate(Routes.ALERT_SETTINGS)
                else context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(Routes.deepLink(Routes.ALERT_SETTINGS))).setPackage(context.packageName))
            },
            onAppearance = vm::setAppearance,
            onOpenAdmin = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(ADMIN_SITE))) },
            onAskForget = vm::askForget, onCancelForget = vm::cancelForget, onConfirmForget = vm::confirmForget,
        ),
    )
}

private fun versionOf(context: Context): String = try {
    val p = context.packageManager.getPackageInfo(context.packageName, 0)
    "${p.versionName} (${p.longVersionCode})"
} catch (_: Exception) { "—" }
