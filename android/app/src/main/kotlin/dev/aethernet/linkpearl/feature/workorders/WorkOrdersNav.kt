package dev.aethernet.linkpearl.feature.workorders

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
import androidx.navigation.navArgument
import androidx.navigation.NavType
import androidx.navigation.navDeepLink
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.nav.Routes

/** Work orders' destinations (agent B). Add sub-routes here; `workorders` and `workorders/{id}` are reserved deep links. */
fun NavGraphBuilder.workOrdersGraph() {
    composable(Routes.WORK_ORDERS, deepLinks = listOf(navDeepLink { uriPattern = Routes.deepLink(Routes.WORK_ORDERS) })) { WorkOrdersScreen() }
    composable(
        Routes.WORK_ORDER,
        arguments = listOf(navArgument(Routes.ARG_ID) { type = NavType.StringType }),
        deepLinks = listOf(navDeepLink { uriPattern = Routes.deepLink(Routes.WORK_ORDER) }),
    ) { entry ->
        val id = entry.arguments?.getString(Routes.ARG_ID).orEmpty()
        Box(Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 12.dp)) {
            Text(id, style = LpType.Title, color = Lp.colors.fg, modifier = Modifier.semantics { heading() })
        }
    }
}
