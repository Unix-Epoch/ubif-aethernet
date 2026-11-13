package dev.aethernet.linkpearl.core.nav

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.LocalActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.core.util.Consumer
import androidx.navigation.NavHostController
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import dev.aethernet.linkpearl.core.data.Auth
import dev.aethernet.linkpearl.core.data.AuthState
import dev.aethernet.linkpearl.core.di.LocalAppContainer
import dev.aethernet.linkpearl.feature.alerts.alertsGraph
import dev.aethernet.linkpearl.feature.home.homeGraph
import dev.aethernet.linkpearl.feature.onboarding.OnboardingScreen
import dev.aethernet.linkpearl.feature.settings.settingsGraph
import dev.aethernet.linkpearl.feature.workorders.workOrdersGraph

/**
 * The app's root: onboarding until the device is registered and approved ([Auth]), then the chrome with the four destinations.
 * Each feature registers its destinations through its own `*Graph()` function; this file only lists them once.
 */
@Composable
fun LinkpearlRoot() {
    val container = LocalAppContainer.current
    val auth = remember { container.get<Auth>() }
    val authState by auth.state.collectAsStateWithLifecycle()
    // Onboarding until the phone is registered, approved and has at least one store (Pending and "No stores" live there too).
    val state = authState
    if (state is AuthState.Registered && state.stores.isNotEmpty()) MainShell() else OnboardingScreen()
}

@Composable
private fun MainShell() {
    val container = LocalAppContainer.current
    val nav = rememberNavController()
    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    val badges by remember { container.get<NavBadges>().counts }.collectAsStateWithLifecycle()
    DeepLinksWhileRunning(nav)
    LpNavScaffold(
        selected = TopLevel.of(route),
        onSelect = { dest ->
            nav.navigate(dest.route) {
                popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                launchSingleTop = true
                restoreState = true
            }
        },
        badges = badges,
        // Phone width: detail screens (alerts/settings, workorders/{id}) are full screen without the bottom bar. They are their own
        // destinations, so Back pops to the screen that opened them.
        showBar = TopLevel.entries.any { it.route == route } || route == null,
    ) {
        NavHost(nav, startDestination = Routes.HOME, modifier = Modifier) {
            homeGraph()
            // Alerts and Settings open each other's screens (alert settings, a work order) inside this one back stack, so Back returns to them.
            alertsGraph(navigate = nav::navigate)
            workOrdersGraph()
            settingsGraph(navigate = { nav.navigate(it) })
        }
    }
}

/**
 * A notification tap or a `linkpearl://` link that arrives while the activity is already running (launch mode singleTask, so no second
 * instance) lands here through `onNewIntent`. The task flags are dropped so the destination goes on top of the current back stack
 * and Back returns to where the owner was.
 */
@Composable
private fun DeepLinksWhileRunning(nav: NavHostController) {
    val activity = LocalActivity.current as? ComponentActivity ?: return
    DisposableEffect(activity, nav) {
        val listener = Consumer<Intent> { intent -> if (intent.data != null) nav.handleDeepLink(Intent(intent).setFlags(0)) }
        activity.addOnNewIntentListener(listener)
        onDispose { activity.removeOnNewIntentListener(listener) }
    }
}
