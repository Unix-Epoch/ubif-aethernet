package dev.aethernet.linkpearl.core.nav

import androidx.compose.runtime.Composable
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
 * The app's root: onboarding until the device is registered ([Auth]), then the chrome with the four destinations.
 * Each feature registers its destinations through its own `*Graph()` function; this file only lists them once.
 */
@Composable
fun LinkpearlRoot() {
    val container = LocalAppContainer.current
    val auth = remember { container.get<Auth>() }
    val authState by auth.state.collectAsStateWithLifecycle()
    if (authState == AuthState.Unregistered) OnboardingScreen() else MainShell()
}

@Composable
private fun MainShell() {
    val container = LocalAppContainer.current
    val nav = rememberNavController()
    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    val badges by remember { container.get<NavBadges>().counts }.collectAsStateWithLifecycle()
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
        // Phone width: detail screens (alerts/settings, workorders/{id}) are full screen without the bottom bar.
        showBar = TopLevel.entries.any { it.route == route } || route == null,
    ) {
        NavHost(nav, startDestination = Routes.HOME, modifier = Modifier) {
            homeGraph()
            alertsGraph()
            workOrdersGraph()
            settingsGraph()
        }
    }
}
