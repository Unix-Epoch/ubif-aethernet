package dev.aethernet.linkpearl.feature.workorders

import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.compose.runtime.CompositionLocalProvider
import dev.aethernet.linkpearl.core.data.Auth
import dev.aethernet.linkpearl.core.data.StoreZone
import kotlinx.coroutines.flow.flowOf
import java.time.ZoneId
import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.LocalAppContainer
import dev.aethernet.linkpearl.core.lock.AppLock
import dev.aethernet.linkpearl.core.lock.SecureWindow
import dev.aethernet.linkpearl.core.nav.LocalAdaptive
import dev.aethernet.linkpearl.core.nav.LpListDetail
import kotlinx.coroutines.launch
import kotlin.time.Duration

private fun AppContainer.authOrNull(): Auth? = runCatching { get<Auth>() }.getOrNull()

/** The stateful Work orders destination: view models, the lock, intents, FLAG_SECURE and the unlock overlay. */
@Composable
fun WorkOrdersRoute(initialId: String? = null) {
    val c = LocalAppContainer.current
    val lock = remember { c.get<AppLock>() }
    val listVm: WorkOrdersViewModel = viewModel(factory = viewModelFactory {
        initializer { WorkOrdersViewModel(c.get<WoRepository>(), c.get<AppLock>(), c.authOrNull(), c.get<WoStorePreference>()) }
    })
    val detailVm: WorkOrderDetailViewModel = viewModel(factory = viewModelFactory {
        initializer { WorkOrderDetailViewModel(c.get<WoRepository>(), c.get<AppLock>(), c.authOrNull()) }
    })
    val list by listVm.state.collectAsStateWithLifecycle()
    val detail by detailVm.state.collectAsStateWithLifecycle()
    val remaining by lock.remaining.collectAsStateWithLifecycle()
    val attempt by lock.attempt.collectAsStateWithLifecycle()
    val unlocked by lock.isUnlocked.collectAsStateWithLifecycle()
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()

    LifecycleResumeEffect(Unit) { listVm.refreshIfStale(); onPauseOrDispose { } }
    // A bare number in the deep link: search for it.
    LaunchedEffect(initialId) { if (initialId != null && WoKey.parse(initialId) == null && initialId.all { it.isDigit() }) listVm.setQuery(initialId) }
    // Customer names on screen: no screenshots, no Recents thumbnail.
    SecureWindow(enabled = unlocked && (list.names.isNotEmpty() || list.search?.results?.isNotEmpty() == true))

    val listActions = WoListActions(
        onUnlock = lock::unlock, onLock = lock::lock, onQuery = listVm::setQuery, onClearQuery = listVm::clearQuery,
        onPickStore = listVm::pickStore, onPickFilter = listVm::pickFilter, onPickSort = listVm::pickSort,
        onRefresh = listVm::refresh, onLoadMore = listVm::loadMore,
    )
    val detailActions = WoDetailActions(
        onRefresh = detailVm::refresh, onUnlock = lock::unlock, onLock = lock::lock,
        onCall = { ctx.dial(it) }, onText = { ctx.text(it) }, onOpenPortal = { ctx.openPortal(it) },
    )
    // Times in the store's zone (from Home), not the phone's.
    val zoneId by remember { runCatching { c.get<StoreZone>().ids }.getOrNull() ?: flowOf(null) }.collectAsStateWithLifecycle(null)
    val clock = remember(zoneId) { zoneId?.let { WoClock(zone = ZoneId.of(it)) } ?: WoClock() }
    CompositionLocalProvider(LocalWoClock provides clock) {
    Box(Modifier.fillMaxSize().then(if (unlocked) Modifier.onAnyTouch { lock.touch() } else Modifier)) {
        WorkOrdersLayout(
            list = list, detail = detail, remaining = remaining,
            initialSelection = WoKey.parse(initialId)?.id, listActions = listActions, detailActions = detailActions,
            onSelect = detailVm::show,
        )
        UnlockOverlay(attempt, onRetry = lock::unlock, onDismiss = lock::dismissAttempt, onRegisterAgain = {
            lock.dismissAttempt()
            scope.launch { c.authOrNull()?.signOut() }
        })
    }
    }
}

/** List and detail through the shared list-detail scaffold: one pane on phones, list left and detail right from 600dp. */
@Composable
fun WorkOrdersLayout(
    list: WoListUi,
    detail: WoDetailUi,
    remaining: Duration?,
    initialSelection: String?,
    listActions: WoListActions,
    detailActions: WoDetailActions,
    onSelect: (WoKey) -> Unit,
) {
    val wide = LocalAdaptive.current.isTwoPane
    val back = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
    LpListDetail<String>(
        list = { select ->
            WorkOrdersScreen(
                state = list, remaining = remaining, selected = if (wide) detail.key else null,
                actions = listActions.copy(onOpen = { row -> onSelect(row.key); select(row.key.id) }),
            )
        },
        detail = { id ->
            LaunchedEffect(id) { WoKey.parse(id)?.let(onSelect) }
            WorkOrderDetailScreen(detail, remaining, showBack = !wide, actions = detailActions.copy(onBack = { back?.onBackPressed() }))
        },
        initialSelection = initialSelection,
        emptyDetail = { NoSelection() },
    )
}

