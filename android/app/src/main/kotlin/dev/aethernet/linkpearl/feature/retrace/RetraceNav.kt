package dev.aethernet.linkpearl.feature.retrace

import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavType
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import androidx.navigation.navDeepLink
import androidx.compose.runtime.CompositionLocalProvider
import dev.aethernet.linkpearl.core.data.Auth
import dev.aethernet.linkpearl.core.data.StoreZone
import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.LocalAppContainer
import dev.aethernet.linkpearl.core.nav.LocalAdaptive
import dev.aethernet.linkpearl.core.nav.Routes
import dev.aethernet.linkpearl.core.nav.SlideInPanelHost
import dev.aethernet.linkpearl.feature.workorders.LocalWoClock
import dev.aethernet.linkpearl.feature.workorders.WoClock
import dev.aethernet.linkpearl.feature.workorders.WoStorePreference
import kotlinx.coroutines.flow.flowOf
import java.time.ZoneId

/**
 * Retrace's destinations: `retrace` (the list), `retrace/item/{store}/{item}` and `retrace/label/{store}/{label}` (also
 * `linkpearl://…`). [navigate] opens another route in the app's own back stack: an item's label opens `retrace/label/…`, a work order
 * reference opens `workorders/{store}-{wo}` (the existing Work orders detail). On phones a detail is a full screen with Back; on wide screens
 * the list stays and the detail is the shared slide-in panel.
 */
fun NavGraphBuilder.retraceGraph(navigate: ((route: String) -> Unit)? = null) {
    composable(Routes.RETRACE, deepLinks = listOf(navDeepLink { uriPattern = Routes.deepLink(Routes.RETRACE) })) { RetraceRoute(null, navigate) }
    composable(
        Routes.RETRACE_ITEM,
        arguments = listOf(navArgument(Routes.ARG_STORE) { type = NavType.IntType }, navArgument(Routes.ARG_ITEM) { type = NavType.StringType }),
        deepLinks = listOf(navDeepLink { uriPattern = Routes.deepLink(Routes.RETRACE_ITEM) }),
    ) { e ->
        val store = e.arguments?.getInt(Routes.ARG_STORE)
        val item = e.arguments?.getString(Routes.ARG_ITEM)
        RetraceRoute(if (store != null && !item.isNullOrBlank()) RtTarget.Item(store, item) else null, navigate)
    }
    composable(
        Routes.RETRACE_LABEL,
        arguments = listOf(navArgument(Routes.ARG_STORE) { type = NavType.IntType }, navArgument(Routes.ARG_LABEL) { type = NavType.StringType }),
        deepLinks = listOf(navDeepLink { uriPattern = Routes.deepLink(Routes.RETRACE_LABEL) }),
    ) { e ->
        val store = e.arguments?.getInt(Routes.ARG_STORE)
        val label = e.arguments?.getString(Routes.ARG_LABEL)
        RetraceRoute(if (store != null && !label.isNullOrBlank()) RtTarget.Label(store, label) else null, navigate)
    }
}

private fun AppContainer.authOrNull(): Auth? = runCatching { get<Auth>() }.getOrNull()

/** The stateful Retrace destination. [initial] set = a detail is open (a deep link or a tap). */
@Composable
fun RetraceRoute(initial: RtTarget?, navigate: ((String) -> Unit)?) {
    val c = LocalAppContainer.current
    val back = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
    val wide = LocalAdaptive.current.isTwoPane
    val zoneId by remember { runCatching { c.get<StoreZone>().ids }.getOrNull() ?: flowOf(null) }.collectAsStateWithLifecycle(null)
    val clock = remember(zoneId) { zoneId?.let { WoClock(zone = ZoneId.of(it)) } ?: WoClock() }
    val go: (String) -> Unit = { route -> navigate?.invoke(route) }
    CompositionLocalProvider(LocalWoClock provides clock) {
        val detailActions = { target: RtTarget ->
            RetraceDetailActions(
                onBack = { back?.onBackPressed() },
                onOpenLabel = { go(Routes.retraceLabel(target.store, it)) },
                onOpenWo = { wo -> go(Routes.workOrder("${target.store}-$wo")) },
            )
        }
        if (initial != null && !wide) {
            DetailContent(initial, detailActions(initial), showBack = true, closeIcon = false, modifier = Modifier)
            return@CompositionLocalProvider
        }
        val listVm: RetraceViewModel = viewModel(factory = viewModelFactory {
            initializer { RetraceViewModel(c.get<RetraceRepository>(), c.authOrNull(), c.get<WoStorePreference>()) }
        })
        val ui by listVm.state.collectAsStateWithLifecycle()
        LifecycleResumeEffect(Unit) { listVm.refreshIfStale(); onPauseOrDispose { } }
        val actions = RetraceActions(
            onQuery = listVm::setQuery, onClearQuery = listVm::clearQuery, onPickStore = listVm::pickStore, onPickView = listVm::pickView,
            onRefresh = listVm::refresh, onLoadMore = listVm::loadMore,
            onOpenItem = { go(Routes.retraceItem(ui.store ?: return@RetraceActions, it.item)) },
            onOpenLabel = { go(Routes.retraceLabel(ui.store ?: return@RetraceActions, it.label)) },
        )
        if (initial == null) {
            RetraceScreen(ui, actions = actions, twoColumns = wide)
        } else {
            SlideInPanelHost(
                open = true, initiallyOpen = true, onClose = { back?.onBackPressed() },
                base = { RetraceScreen(ui, actions = actions, twoColumns = true, selectedItem = (initial as? RtTarget.Item)?.item) },
                panel = { top -> DetailContent(initial, detailActions(initial), showBack = true, closeIcon = true, modifier = Modifier.padding(top = top)) },
            )
        }
    }
}

@Composable
private fun DetailContent(target: RtTarget, actions: RetraceDetailActions, showBack: Boolean, closeIcon: Boolean, modifier: Modifier) {
    val c = LocalAppContainer.current
    val vm: RetraceDetailViewModel = viewModel(key = "rt-" + target.toString(), factory = viewModelFactory {
        initializer { RetraceDetailViewModel(c.get<RetraceRepository>(), c.authOrNull(), target) }
    })
    val wired = actions.copy(onRetry = vm::refresh)
    when (target) {
        is RtTarget.Item -> { val ui by vm.item.collectAsStateWithLifecycle(); RetraceItemScreen(ui, target.item, target.store, showBack, wired, modifier, closeIcon) }
        is RtTarget.Label -> { val ui by vm.label.collectAsStateWithLifecycle(); RetraceLabelScreen(ui, target.label, target.store, showBack, wired, modifier, closeIcon) }
    }
}
