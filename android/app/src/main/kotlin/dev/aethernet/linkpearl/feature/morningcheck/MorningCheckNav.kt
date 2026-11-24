package dev.aethernet.linkpearl.feature.morningcheck

import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import androidx.navigation.navDeepLink
import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.FeatureModule
import dev.aethernet.linkpearl.core.di.LocalAppContainer
import dev.aethernet.linkpearl.core.nav.Routes
import dev.aethernet.linkpearl.feature.linkshell.LinkshellClient
import dev.aethernet.linkpearl.feature.pullbacks.PullbackCamera
import dev.aethernet.linkpearl.feature.scan.SCAN_FORMATS

/** Morning check's half of Linkshell (one per app, so a check survives leaving the screen). */
object MorningCheckModule : FeatureModule {
    override fun install(c: AppContainer) {
        c.provide<MorningCheckLink> { MorningCheckLink(c.get<LinkshellClient>()) }
    }
}

/** `morningcheck` (also `linkpearl://morningcheck`), opened from Work orders' header. */
fun NavGraphBuilder.morningCheckGraph(navigate: (String) -> Unit) {
    composable(Routes.MORNING_CHECK, deepLinks = listOf(navDeepLink { uriPattern = Routes.deepLink(Routes.MORNING_CHECK) })) { MorningCheckRoute(navigate) }
}

@Composable
fun MorningCheckRoute(navigate: (String) -> Unit) {
    val c = LocalAppContainer.current
    val back = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
    val vm: MorningCheckViewModel = viewModel(factory = viewModelFactory { initializer { MorningCheckViewModel(c.get<MorningCheckLink>()) } })
    val ui by vm.state.collectAsStateWithLifecycle()
    MorningCheckScreen(
        ui,
        McActions(
            onBack = { back?.onBackPressed() }, onOrder = vm::pickOrder, onStart = vm::start, onLooksRight = vm::looksRight, onSkip = vm::skip,
            onNext = vm::next, onSave = vm::save, onRetry = vm::retry, onScan = vm::scan, onCheckSkipped = vm::checkSkipped,
            onFinish = vm::finish, onAgain = vm::again, onLinkshell = { navigate(Routes.LINKSHELL) },
        ),
        // Work order labels only: Code 128, the WO number.
        camera = { onCode -> PullbackCamera("", onCode, SCAN_FORMATS) },
    )
}
