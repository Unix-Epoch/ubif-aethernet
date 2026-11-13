package dev.aethernet.linkpearl.feature.alerts

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import androidx.navigation.navDeepLink
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.nav.Routes

/** Alerts' destinations (agent C). Notifications open `linkpearl://alerts`, `linkpearl://alerts/settings` or a work order. */
fun NavGraphBuilder.alertsGraph() {
    composable(Routes.ALERTS, deepLinks = listOf(navDeepLink { uriPattern = Routes.deepLink(Routes.ALERTS) })) { AlertsScreen() }
    composable(Routes.ALERT_SETTINGS, deepLinks = listOf(navDeepLink { uriPattern = Routes.deepLink(Routes.ALERT_SETTINGS) })) {
        Box(Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 12.dp)) {
            Text("Alert settings", style = LpType.Title, color = Lp.colors.fg, modifier = Modifier.semantics { heading() })
        }
    }
}
