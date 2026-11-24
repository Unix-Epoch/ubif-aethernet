package dev.aethernet.linkpearl.feature.buybacks

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

/** Buyback scans over Linkshell: the phone's half. */
object BuybacksModule : FeatureModule {
    override fun install(c: AppContainer) {
        c.provide<BuybackLink> { BuybackLink(c.get<LinkshellClient>()) }
    }
}

/** `buybacks` (also `linkpearl://buybacks`), opened with Join on the Linkshell screen. */
fun NavGraphBuilder.buybacksGraph() {
    composable(Routes.BUYBACKS, deepLinks = listOf(navDeepLink { uriPattern = Routes.deepLink(Routes.BUYBACKS) })) { BuybacksRoute() }
}

@Composable
fun BuybacksRoute() {
    val c = LocalAppContainer.current
    val back = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
    val vm: BuybackViewModel = viewModel(factory = viewModelFactory { initializer { BuybackViewModel(c.get<BuybackLink>()) } })
    val ui by vm.state.collectAsStateWithLifecycle()
    BuybackScreen(
        ui,
        BuybackActions(onBack = { back?.onBackPressed() }, onCode = vm::onCode),
        camera = { onCode -> PullbackCamera("", onCode) },
    )
}
