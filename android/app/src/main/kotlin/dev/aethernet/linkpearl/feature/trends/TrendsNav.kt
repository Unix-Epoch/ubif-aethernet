package dev.aethernet.linkpearl.feature.trends

import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavType
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import androidx.navigation.navDeepLink
import dev.aethernet.linkpearl.core.data.Auth
import dev.aethernet.linkpearl.core.data.StoreScope
import dev.aethernet.linkpearl.core.di.LocalAppContainer
import dev.aethernet.linkpearl.core.nav.Routes

/** `trends/{store}` (`all` or a store id; also `linkpearl://trends/…`), opened from Home's sales card with Home's store. */
fun NavGraphBuilder.trendsGraph() {
    composable(
        Routes.TRENDS, arguments = listOf(navArgument(Routes.ARG_STORE) { type = NavType.StringType; defaultValue = "all" }),
        deepLinks = listOf(navDeepLink { uriPattern = Routes.deepLink(Routes.TRENDS) }),
    ) { e -> TrendsRoute(StoreScope.fromKey(e.arguments?.getString(Routes.ARG_STORE))) }
}

@Composable
fun TrendsRoute(initial: StoreScope) {
    val c = LocalAppContainer.current
    val back = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
    val vm: TrendsViewModel = viewModel(factory = viewModelFactory {
        initializer { TrendsViewModel(c.get<TrendsRepository>(), runCatching { c.get<Auth>() }.getOrNull(), initial) }
    })
    val ui by vm.state.collectAsStateWithLifecycle()
    TrendsScreen(
        ui,
        TrendsActions(
            onBack = { back?.onBackPressed() }, onPeriod = vm::pickPeriod, onScope = vm::pickScope,
            onPrevious = vm::previous, onNext = vm::next, onRefresh = vm::refresh,
        ),
    )
}
