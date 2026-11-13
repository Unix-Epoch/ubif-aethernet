package dev.aethernet.linkpearl.feature.home

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import androidx.navigation.navDeepLink
import dev.aethernet.linkpearl.core.di.LocalAppContainer
import dev.aethernet.linkpearl.core.nav.Routes
import kotlinx.coroutines.delay

/** Home's destination, registered by core/nav's NavHost. */
fun NavGraphBuilder.homeGraph() {
    composable(Routes.HOME, deepLinks = listOf(navDeepLink { uriPattern = Routes.deepLink(Routes.HOME) })) { HomeRoute() }
}

@Composable
fun HomeRoute(modifier: Modifier = Modifier) {
    val container = LocalAppContainer.current
    val vm: HomeViewModel = viewModel(factory = HomeViewModel.factory(container))
    val state by vm.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // Auto-refresh while Home is on screen: once a minute, and on return to the app.
    LaunchedEffect(vm, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            vm.refreshIfStale()
            while (true) { delay(60_000); vm.refreshIfStale() }
        }
    }
    HomeScreen(state, onPickStore = vm::pick, onRefresh = vm::refresh, modifier = modifier)
}
