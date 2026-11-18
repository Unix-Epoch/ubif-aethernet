package dev.aethernet.linkpearl.feature.scan

import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import androidx.navigation.navDeepLink
import dev.aethernet.linkpearl.core.data.Auth
import dev.aethernet.linkpearl.core.data.AuthState
import dev.aethernet.linkpearl.core.di.LocalAppContainer
import dev.aethernet.linkpearl.core.nav.Routes
import dev.aethernet.linkpearl.feature.pullbacks.PullbackCamera
import dev.aethernet.linkpearl.feature.retrace.RetraceRepository
import dev.aethernet.linkpearl.feature.workorders.WoStorePreference

/**
 * `scan` (also `linkpearl://scan`), opened from the Scan button on Home, Work orders and Retrace. [open] goes to the scanned work order or
 * label in place of this screen, so Back returns to where the scan started.
 */
fun NavGraphBuilder.scanGraph(open: (String) -> Unit) {
    composable(Routes.SCAN, deepLinks = listOf(navDeepLink { uriPattern = Routes.deepLink(Routes.SCAN) })) { ScanRoute(open) }
}

@Composable
fun ScanRoute(open: (String) -> Unit) {
    val c = LocalAppContainer.current
    val back = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
    val vm: ScanViewModel = viewModel(factory = viewModelFactory {
        initializer {
            val stores = (runCatching { c.get<Auth>() }.getOrNull()?.state?.value as? AuthState.Registered)?.stores?.map { it.id }.orEmpty()
            ScanViewModel(c.get<RetraceRepository>(), stores, c.get<WoStorePreference>())
        }
    })
    val ui by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(ui.open) { ui.open?.let { vm.opened(); open(it) } }
    ScanScreen(
        ui, onBack = { back?.onBackPressed() }, onCode = vm::onCode,
        camera = { onCode -> PullbackCamera("", onCode, SCAN_FORMATS) },
    )
}
