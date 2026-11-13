package dev.aethernet.linkpearl.feature.workorders

import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavType
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import androidx.navigation.navDeepLink
import dev.aethernet.linkpearl.core.nav.Routes

/**
 * Work orders' destinations. `workorders` is the list (list-detail on wide screens). `workorders/{id}` opens one work order:
 * id = "<store>-<wo>" (e.g. `linkpearl://workorders/914-7000001`, also "914:7000001"); a bare number searches for it instead.
 */
fun NavGraphBuilder.workOrdersGraph() {
    composable(Routes.WORK_ORDERS, deepLinks = listOf(navDeepLink { uriPattern = Routes.deepLink(Routes.WORK_ORDERS) })) { WorkOrdersRoute() }
    composable(
        Routes.WORK_ORDER,
        arguments = listOf(navArgument(Routes.ARG_ID) { type = NavType.StringType }),
        deepLinks = listOf(navDeepLink { uriPattern = Routes.deepLink(Routes.WORK_ORDER) }),
    ) { entry -> WorkOrdersRoute(initialId = entry.arguments?.getString(Routes.ARG_ID)) }
}
