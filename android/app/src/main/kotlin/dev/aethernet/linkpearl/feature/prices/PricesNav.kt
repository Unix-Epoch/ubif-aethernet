package dev.aethernet.linkpearl.feature.prices

import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
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
import dev.aethernet.linkpearl.core.data.StoreZone
import dev.aethernet.linkpearl.core.di.LocalAppContainer
import dev.aethernet.linkpearl.core.nav.Routes
import java.time.LocalDate
import java.time.ZoneId

/** `prices/{store}` (a store id, or `all` for the first approved store; also `linkpearl://prices/…`), opened from Home's header. */
fun NavGraphBuilder.pricesGraph() {
    composable(
        Routes.PRICES, arguments = listOf(navArgument(Routes.ARG_STORE) { type = NavType.StringType; defaultValue = "all" }),
        deepLinks = listOf(navDeepLink { uriPattern = Routes.deepLink(Routes.PRICES) }),
    ) { e -> PricesRoute(e.arguments?.getString(Routes.ARG_STORE)?.toIntOrNull()) }
}

@Composable
fun PricesRoute(store: Int?) {
    val c = LocalAppContainer.current
    val back = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
    val vm: PricesViewModel = viewModel(factory = viewModelFactory {
        initializer { PricesViewModel(c.get<PricesRepository>(), runCatching { c.get<Auth>() }.getOrNull(), store) }
    })
    val ui by vm.state.collectAsStateWithLifecycle()
    val tz = remember { runCatching { c.get<StoreZone>().id }.getOrNull() ?: StoreZone.FALLBACK }
    val today = remember(tz) { LocalDate.now(ZoneId.of(tz)).toString() }
    val share = rememberShare()
    PricesScreen(
        ui, tz, today,
        PricesActions(
            onBack = { back?.onBackPressed() }, onQuery = vm::setQuery, onClear = vm::clearQuery, onChoose = vm::choose, onMatch = vm::pickMatch,
            onStore = vm::pickStore, onRefresh = vm::refresh, onShare = share,
        ),
    )
}
