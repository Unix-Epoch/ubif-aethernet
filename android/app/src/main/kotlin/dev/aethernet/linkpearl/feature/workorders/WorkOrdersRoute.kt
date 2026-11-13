package dev.aethernet.linkpearl.feature.workorders

import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.ui.layout.layout
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpShapes
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

/**
 * Phones and the cover screen: list, then full-screen detail with back (the shared list-detail scaffold). Wide screens (600dp and up):
 * the list takes the full width and the detail opens over it as a popover (a panel sliding in from the right).
 */
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
    if (wide) {
        WideWorkOrders(list, detail, remaining, initialSelection, listActions, detailActions, onSelect)
        return
    }
    LpListDetail<String>(
        list = { select ->
            WorkOrdersScreen(
                state = list, remaining = remaining, selected = null,
                actions = listActions.copy(onOpen = { row -> onSelect(row.key); select(row.key.id) }),
            )
        },
        detail = { id ->
            LaunchedEffect(id) { WoKey.parse(id)?.let(onSelect) }
            WorkOrderDetailScreen(detail, remaining, showBack = true, actions = detailActions.copy(onBack = { back?.onBackPressed() }))
        },
        initialSelection = initialSelection,
        emptyDetail = { NoSelection() },
    )
}

/** The list at full width; the detail is a right-anchored panel (90% of the width, top of the screen to the bottom bar) over a scrim. */
@Composable
private fun WideWorkOrders(
    list: WoListUi, detail: WoDetailUi, remaining: Duration?, initialSelection: String?,
    listActions: WoListActions, detailActions: WoDetailActions, onSelect: (WoKey) -> Unit,
) {
    var open by remember { mutableStateOf(initialSelection != null) }
    var openId by remember { mutableStateOf(initialSelection) }
    // Starts settled open when a work order is already selected (deep link, tests); animates only on later changes.
    val visible = remember { MutableTransitionState(initialSelection != null) }
    visible.targetState = open
    Box(Modifier.fillMaxSize()) {
        WorkOrdersScreen(
            state = list, remaining = remaining, twoColumns = true,
            actions = listActions.copy(onOpen = { row -> onSelect(row.key); openId = row.key.id; open = true }),
        )
        openId?.let { id -> LaunchedEffect(id) { WoKey.parse(id)?.let(onSelect) } }
        BackHandler(enabled = open) { open = false }
        val c = Lp.colors
        // The content area sits below the status bar; the scrim and panel reach up under it, and the panel pads its content back down.
        val topInset = WindowInsets.safeDrawing.getTop(LocalDensity.current)
        val reachUp = Modifier.layout { m, cs ->
            val p = m.measure(cs.copy(minHeight = cs.maxHeight + topInset, maxHeight = cs.maxHeight + topInset))
            layout(p.width, cs.maxHeight) { p.place(0, -topInset) }
        }
        AnimatedVisibility(visible, enter = fadeIn(tween(250)), exit = fadeOut(tween(250))) {
            Box(reachUp.fillMaxSize().background(c.page.copy(alpha = 0.6f)).pointerInput(Unit) { detectTapGestures { open = false } })
        }
        AnimatedVisibility(
            visible, modifier = Modifier.align(Alignment.CenterEnd).then(reachUp).fillMaxWidth(0.9f),
            enter = slideInHorizontally(tween(250)) { it }, exit = slideOutHorizontally(tween(250)) { it },
        ) {
            val shape = RoundedCornerShape(topStart = 24.dp, bottomStart = 24.dp)
            Box(
                Modifier.fillMaxSize().clip(shape).background(c.page).border(1.dp, c.line, shape)
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {},
            ) {
                WorkOrderDetailScreen(
                    detail, remaining, showBack = true, closeIcon = true, actions = detailActions.copy(onBack = { open = false }),
                    modifier = Modifier.padding(top = with(LocalDensity.current) { topInset.toDp() }),
                )
            }
        }
    }
}
