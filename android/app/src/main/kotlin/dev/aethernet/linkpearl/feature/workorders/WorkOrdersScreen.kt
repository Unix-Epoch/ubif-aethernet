package dev.aethernet.linkpearl.feature.workorders

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.runtime.withFrameNanos
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.compose.ui.unit.Density
import dev.aethernet.linkpearl.core.nav.LocalAdaptive
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.design.AsOfLine
import dev.aethernet.linkpearl.core.design.ChoiceRow
import dev.aethernet.linkpearl.core.design.Fmt
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpDisplay
import dev.aethernet.linkpearl.core.design.LpDot
import dev.aethernet.linkpearl.core.design.LpPullToRefresh
import dev.aethernet.linkpearl.core.design.enter
import dev.aethernet.linkpearl.core.design.fg
import dev.aethernet.linkpearl.core.design.glass
import dev.aethernet.linkpearl.core.design.lpSurface
import dev.aethernet.linkpearl.core.design.pressScale
import dev.aethernet.linkpearl.core.design.rememberHaptics
import dev.aethernet.linkpearl.core.design.storeColor
import dev.aethernet.linkpearl.core.nav.LocalNavInset
import dev.aethernet.linkpearl.core.nav.sharedCard
import dev.aethernet.linkpearl.core.design.LpBottomSheet
import dev.aethernet.linkpearl.core.design.LpIcon
import dev.aethernet.linkpearl.core.design.LpIconButton
import dev.aethernet.linkpearl.core.design.LpChip
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.design.LpSegmented
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.design.NoticeLine
import dev.aethernet.linkpearl.core.design.PillButton
import dev.aethernet.linkpearl.core.design.Skeleton
import dev.aethernet.linkpearl.core.design.StateMessage
import dev.aethernet.linkpearl.core.design.Tone
import dev.aethernet.linkpearl.core.design.fg
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlin.time.Duration

/** Everything the list pane can ask for. Defaults do nothing (previews, the nav chrome test). */
data class WoListActions(
    val onUnlock: () -> Unit = {},
    val onLock: () -> Unit = {},
    val onQuery: (String) -> Unit = {},
    val onClearQuery: () -> Unit = {},
    val onPickStore: (Int?) -> Unit = {},
    val onPickFilter: (LaneFilter) -> Unit = {},
    val onPickSort: (WoSort) -> Unit = {},
    val onRefresh: () -> Unit = {},
    val onLoadMore: () -> Unit = {},
    val onOpen: (WoRow) -> Unit = {},
    val onScan: (() -> Unit)? = null,
    val onMorningCheck: (() -> Unit)? = null,
)

/**
 * The Work orders list pane, stateless: header with the lock control, search, lane chips, store and sort, then the rows (or the
 * search results). Locked rows show a lock glyph where the customer goes; unlocked rows show the name from the decrypted card.
 */
@Composable
fun WorkOrdersScreen(
    modifier: Modifier = Modifier,
    state: WoListUi = WoListUi(),
    remaining: Duration? = null,
    selected: WoKey? = null,
    actions: WoListActions = WoListActions(),
    /** Wide screens: cards in two columns, the gap on the fold when one is known. */
    twoColumns: Boolean = false,
) {
    // The search field never takes focus on its own: coming back to this screen (from a work order, the scanner, another tab or
    // another app) leaves the keyboard down. Focus is dropped on the way out and again on the way back in.
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val dropFocus = { focusManager.clearFocus(force = true); keyboard?.hide() }
    LaunchedEffect(Unit) { withFrameNanos { }; dropFocus() }
    LifecycleResumeEffect(Unit) { dropFocus(); onPauseOrDispose { } }
    val actions = actions.copy(
        onOpen = { row -> dropFocus(); actions.onOpen(row) },
        onScan = actions.onScan?.let { scan -> { dropFocus(); scan() } },
    )
    val nowMs = rememberNowMs(state.skewMs)
    var storeMenu by remember { mutableStateOf(false) }
    val listState = rememberLazyGridState()
    var originX by remember { mutableFloatStateOf(0f) }
    val hinge = LocalAdaptive.current.hinge
    val cells: GridCells = if (twoColumns) rememberTwoColumnCells(hinge, originX) else GridCells.Fixed(1)
    val colGap = if (twoColumns) twoColumnGap(hinge) else 0.dp
    val onLoadMore by rememberUpdatedState(actions.onLoadMore)
    LaunchedEffect(listState) {
        snapshotFlow { listState.layoutInfo.let { it.totalItemsCount > 0 && (it.visibleItemsInfo.lastOrNull()?.index ?: 0) >= it.totalItemsCount - 4 } }
            .distinctUntilChanged().filter { it }.collect { onLoadMore() }
    }
    val search = state.search

    Column(modifier.fillMaxSize().onGloballyPositioned { originX = it.positionInWindow().x }) {
        Column(Modifier.padding(horizontal = LpSpacing.Gutter).padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
            Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Work orders", style = LpType.Screen, color = Lp.colors.fg, modifier = Modifier.weight(1f).semantics { heading() }, maxLines = 1)
                actions.onMorningCheck?.let { LpIconButton(LpIcons.Sunrise, "Morning check", it) }
                actions.onScan?.let { LpIconButton(LpIcons.Scan, "Scan", it) }
                LockControl(state.unlocked, remaining, actions.onUnlock, actions.onLock)
            }
            SearchField(state.query, state.unlocked, actions.onQuery, actions.onClearQuery, actions.onUnlock)
            if (search == null) {
                LpSegmented(listOf("Open", "Closed"), if (state.filter == LaneFilter.Closed) 1 else 0, { actions.onPickFilter(if (it == 1) LaneFilter.Closed else LaneFilter.All) })
                if (state.filter != LaneFilter.Closed) LaneChips(state.lanes, state.filter, actions.onPickFilter, state.followUps, state.old)
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StorePill(if (state.store == null) "All stores" else state.storeName(state.store)) { storeMenu = true }
                    Spacer(Modifier.weight(1f))
                    SortControl(state.sort, state.filter == LaneFilter.Closed, actions.onPickSort)
                }
            }
        }

        if (search != null) {
            SearchResults(state, search, nowMs, selected, actions, cells, colGap)
        } else {
            when (state.view) {
                LoadView.Loading -> Column(Modifier.padding(LpSpacing.Gutter), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) { repeat(4) { SkeletonRow() } }
                LoadView.Error -> StateMessage(problemText(state.problem), actionLabel = if (canRetry(state.problem)) "Retry" else null, onAction = actions.onRefresh)
                LoadView.Ok -> LpPullToRefresh(refreshing = state.refreshing, onRefresh = actions.onRefresh, modifier = Modifier.fillMaxSize()) {
                    LazyVerticalGrid(
                        columns = cells, state = listState, modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(start = LpSpacing.Gutter, end = LpSpacing.Gutter, top = LpSpacing.M, bottom = 24.dp + LocalNavInset.current),
                        verticalArrangement = Arrangement.spacedBy(LpSpacing.M), horizontalArrangement = Arrangement.spacedBy(colGap),
                    ) {
                        state.problem?.let { p ->
                            item(key = "banner", span = { GridItemSpan(maxLineSpan) }) {
                                val at = state.receivedAtMs?.let { java.time.Instant.ofEpochMilli(it).toString() }
                                val clock = Fmt.clock(at, LocalWoClock.current.zone.id)
                                when (p) {
                                    Problem.Offline -> NoticeLine(Fmt.offline(clock), LpIcons.WifiOff, Modifier.fillMaxWidth())
                                    else -> NoticeLine(problemText(p), LpIcons.Warning, Modifier.fillMaxWidth(), warn = true, actionLabel = if (canRetry(p)) "Retry" else null, onAction = actions.onRefresh)
                                }
                            }
                        }
                        if (state.rows.isEmpty()) item(key = "empty", span = { GridItemSpan(maxLineSpan) }) { EmptyLane() }
                        itemsIndexed(state.rows, key = { _, r -> r.key.id }) { i, row ->
                            // The first screenful rises in one after another; rows scrolled to later just rise in.
                            Box(Modifier.enter(if (i < 8) i else 0)) {
                                if (state.filter == LaneFilter.Closed) ClosedWoCard(row, state, selected == row.key) { actions.onOpen(row) }
                                else WoRowCard(row, state, nowMs, selected == row.key) { actions.onOpen(row) }
                            }
                        }
                        if (state.loadingMore) item(key = "more", span = { GridItemSpan(maxLineSpan) }) { SkeletonRow() }
                    }
                }
            }
        }
    }

    if (storeMenu) {
        LpBottomSheet(onDismiss = { storeMenu = false }) {
            ChoiceRow("All stores", state.store == null, { storeMenu = false; actions.onPickStore(null) })
            state.stores.forEach { s -> ChoiceRow(s.label, state.store == s.id, { storeMenu = false; actions.onPickStore(s.id) }) }
        }
    }
}

/** Gap between the two columns: the fold's width when it has one, at least the pane gutter. */
@Composable
internal fun twoColumnGap(hinge: androidx.compose.ui.geometry.Rect?): androidx.compose.ui.unit.Dp {
    val d = LocalDensity.current
    val hw = if (hinge != null) with(d) { (hinge.right - hinge.left).toDp() } else 0.dp
    return maxOf(hw, LpSpacing.PaneGutter)
}

/** Two columns split on the fold (window px, [originX] is this list's own left edge in the window); an even split without one. */
@Composable
internal fun rememberTwoColumnCells(hinge: androidx.compose.ui.geometry.Rect?, originX: Float): GridCells {
    val d = LocalDensity.current
    val gutter = with(d) { LpSpacing.Gutter.roundToPx() }
    return remember(hinge, originX, gutter) {
        object : GridCells {
            override fun Density.calculateCrossAxisCellSizes(availableSize: Int, spacing: Int): List<Int> {
                val cells = availableSize - spacing
                val cx = hinge?.center?.x?.minus(originX)?.minus(gutter)
                val usable = cx != null && cx in (availableSize * 0.2f)..(availableSize * 0.8f)
                val left = if (usable) (cx!! - spacing / 2f).toInt() else cells / 2
                return listOf(left.coerceIn(0, cells), cells - left.coerceIn(0, cells))
            }
        }
    }
}

@Composable
private fun SearchResults(state: WoListUi, search: SearchUi, nowMs: Long, selected: WoKey?, actions: WoListActions, cells: GridCells, colGap: androidx.compose.ui.unit.Dp) {
    when {
        search.busy -> Column(Modifier.padding(LpSpacing.Gutter), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) { repeat(2) { SkeletonRow() } }
        search.results.isNotEmpty() -> LazyVerticalGrid(
            cells, Modifier.fillMaxSize(), contentPadding = PaddingValues(start = LpSpacing.Gutter, end = LpSpacing.Gutter, top = LpSpacing.M, bottom = 24.dp + LocalNavInset.current),
            verticalArrangement = Arrangement.spacedBy(LpSpacing.M), horizontalArrangement = Arrangement.spacedBy(colGap),
        ) {
            items(search.results, key = { "s" + it.key.id }) { row -> WoRowCard(row, state, nowMs, selected == row.key, showStoreAlways = true) { actions.onOpen(row) } }
        }
        search.problem != null && search.problem != Problem.NotFound -> StateMessage(problemText(search.problem), actionLabel = "Retry") { actions.onQuery(search.query) }
        else -> NoResults(search, state.unlocked, actions)
    }
}

/** "No match for 70000099" with Clear and, while locked, "Unlock to search names". */
@Composable
private fun NoResults(search: SearchUi, unlocked: Boolean, actions: WoListActions) {
    val c = Lp.colors
    Column(Modifier.fillMaxWidth().padding(horizontal = LpSpacing.L, vertical = 40.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(LpSpacing.L)) {
        IconBadge(if (search.needsUnlock) LpIcons.Lock else LpIcons.Search, size = 80.dp, tint = if (search.needsUnlock) c.onAccSoft else c.warn, background = if (search.needsUnlock) c.accSoft else c.warnBg)
        if (!search.needsUnlock) Text("No match for ${search.query}", style = LpType.Row.copy(fontWeight = FontWeight.SemiBold), color = c.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Row(horizontalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
            OutlineButton("Clear", null, actions.onClearQuery)
            if (!unlocked) PillButton("Unlock to search names", actions.onUnlock, icon = LpIcons.Lock)
        }
    }
}

@Composable
private fun EmptyLane() {
    Column(Modifier.fillMaxWidth().padding(vertical = 40.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(LpSpacing.L)) {
        IconBadge(LpIcons.Check, size = 80.dp, tint = Lp.colors.good, background = Lp.colors.goodBg)
        Text("No work orders here", style = LpType.Row.copy(fontWeight = FontWeight.SemiBold), color = Lp.colors.fg)
    }
}

/** One work order card: number, location and time in status; device, issue and program; status chip, Urgent and store; the customer line. */
@Composable
fun WoRowCard(row: WoRow, state: WoListUi, nowMs: Long, selected: Boolean, showStoreAlways: Boolean = false, onClick: () -> Unit) {
    val c = Lp.colors
    val shape = LpShapes.Card
    val old = WoAging.isOld(row, nowMs)
    val stripe = if (old) c.warn else laneTone(row.lane).fg()
    val interaction = remember { MutableInteractionSource() }
    Column(
        Modifier.fillMaxWidth().pressScale(interaction).sharedCard("wo-${row.key.id}").lpSurface(shape)
            .let { if (selected) it.background(c.accSoft.copy(alpha = 0.6f)).border(2.dp, c.acc, shape) else it }
            // The lane's colour as a stripe down the left edge (the status chip carries it in words); an old card's edge is amber and
            // full height, with "Old" and the hourglass on its time chip.
            .drawBehind {
                if (old) drawRoundRect(stripe, Offset(0f, 10.dp.toPx()), Size(5.dp.toPx(), size.height - 20.dp.toPx()), CornerRadius(2.5.dp.toPx()))
                else drawRoundRect(stripe, Offset(0f, 16.dp.toPx()), Size(4.dp.toPx(), size.height - 32.dp.toPx()), CornerRadius(2.dp.toPx()))
            }
            .clickable(interaction, LocalIndication.current, role = Role.Button, onClick = onClick).semantics { this.selected = selected }
            .padding(start = 20.dp, end = 16.dp, top = 14.dp, bottom = 14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(row.wo.toString(), style = LpType.Number, color = c.fg, maxLines = 1)
            Box(Modifier.weight(1f).padding(start = 10.dp, end = 8.dp)) {
                row.bin?.trim()?.takeIf { it.isNotEmpty() }?.let { bin ->
                    LpChip(bin, Modifier.clearAndSetSemantics { contentDescription = "Location $bin" }, icon = LpIcons.Pin)
                }
            }
            if (old) OldChip(row, nowMs) else if (row.open) TimeInStatus(row.statusSince, nowMs) else Text(WoFmt.shortDayTime(row.closedAt, LocalWoClock.current.zone), style = LpType.Small, color = c.soft)
        }
        val issue = row.issues?.takeIf { it.isNotEmpty() }?.joinToString(", ")
        val sub = listOfNotNull(row.device, issue, row.program).joinToString(Fmt.DOT).ifEmpty { Fmt.DASH }
        Text(sub, style = LpType.Row, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusChip(row.status, row.lane)
                if (row.urgent) LpChip("Urgent", tone = Tone.Warn, icon = LpIcons.Warning)
            }
            if (state.showStore || showStoreAlways) {
                val idx = state.stores.indexOfFirst { it.id == row.store }
                Row(Modifier.weight(1f, fill = false).padding(start = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (idx >= 0) LpDot(storeColor(idx), size = 8.dp)
                    Text(state.storeName(row.store), style = LpType.Small, color = c.soft, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = androidx.compose.ui.text.style.TextAlign.End)
                }
            }
        }
        if (row.tags.isNotEmpty()) TagRow(row.tags)
        val follow = row.followUp?.takeIf { it.valid }
        if (follow != null) FollowUpMarker(follow, state.followUps?.today ?: todayLocal(nowMs))
        Box(Modifier.fillMaxWidth().padding(vertical = 4.dp).height(1.dp).background(c.fg.copy(alpha = 0.07f)))
        CustomerLine(row, state)
    }
}

/** The card's bottom line: the customer after unlock, a lock while locked. */
@Composable
internal fun CustomerLine(row: WoRow, state: WoListUi) {
    val c = Lp.colors
    val name = state.names[row.key]
    Row(Modifier.heightIn(min = 28.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        when {
            !state.unlocked -> {
                LpIcon(LpIcons.Lock, "Customer locked", size = 20.dp, tint = c.soft)
                Bar(92.dp, height = 10.dp)
            }
            name != null -> {
                LpIcon(LpIcons.Person, null, size = 20.dp, tint = c.fg)
                Text(name, style = LpType.Body, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            row.store in state.noKeyStores -> {
                LpIcon(LpIcons.Lock, null, size = 20.dp, tint = c.soft)
                Text("No key", style = LpType.Small, color = c.soft)
            }
            else -> {
                LpIcon(LpIcons.Person, null, size = 20.dp, tint = c.soft)
                Text(Fmt.DASH, style = LpType.Body, color = c.soft)
            }
        }
    }
}

@Composable
internal fun SkeletonRow() {
    Column(
        Modifier.fillMaxWidth().lpSurface(LpShapes.Card).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row { Skeleton(width = 130.dp, height = 20.dp); Spacer(Modifier.weight(1f)); Skeleton(width = 60.dp) }
        Skeleton(width = 190.dp)
        Skeleton(width = 120.dp, height = 22.dp)
    }
}

/** The search field. Locked: "Number" plus a lock chip for name / phone / IMEI (tapping it starts unlocking). */
@Composable
fun SearchField(query: String, unlocked: Boolean, onQuery: (String) -> Unit, onClear: () -> Unit, onUnlock: () -> Unit, modifier: Modifier = Modifier, placeholder: String? = null) {
    val c = Lp.colors
    Row(
        modifier.fillMaxWidth().heightIn(min = 56.dp).glass().padding(start = 18.dp, end = 6.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        LpIcon(LpIcons.Search, null, tint = c.soft)
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
            if (query.isEmpty()) Text(placeholder ?: if (unlocked) "Number, name, phone, IMEI" else "Number", style = LpType.Row, color = c.soft, maxLines = 1, overflow = TextOverflow.Ellipsis)
            BasicTextField(
                value = query, onValueChange = onQuery, singleLine = true,
                textStyle = LpType.Row.copy(color = c.fg), cursorBrush = SolidColor(c.acc),
                // Locked: digits only (number lookup). Unlocked: any text, never auto-corrected or learned by the keyboard.
                keyboardOptions = KeyboardOptions(keyboardType = if (unlocked) KeyboardType.Text else KeyboardType.Number, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = placeholder ?: if (unlocked) "Search number, name, phone or IMEI" else "Search number" },
            )
        }
        if (query.isNotEmpty()) LpIconButton(LpIcons.Close, "Clear search", onClear)
        else if (!unlocked) {
            Row(
                Modifier.heightIn(min = 40.dp).clip(LpShapes.Pill).background(c.surf2).clickable(role = Role.Button, onClickLabel = "Unlock to search names", onClick = onUnlock).padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                LpIcon(LpIcons.Lock, null, size = 18.dp, tint = c.fg)
                Text("Name, phone, IMEI", style = LpType.Chip, color = c.fg, maxLines = 1)
            }
        }
    }
}

@Composable
private fun LaneChips(lanes: WoLanes?, filter: LaneFilter, onPick: (LaneFilter) -> Unit, followUps: FollowUpsInfo?, old: Int?) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilterChip("All", lanes?.total, filter == LaneFilter.All) { onPick(LaneFilter.All) }
        // Counted by the app (WoAging); shown once the count is in, or while its filter is on.
        if (old != null || filter == LaneFilter.Old) FilterChip("Old", old, filter == LaneFilter.Old) { onPick(LaneFilter.Old) }
        // Next to All so it is on screen. Only a tracker that answers with follow-up counts has the filter.
        if (followUps != null) FilterChip("Follow-ups", followUps.count, filter == LaneFilter.FollowUps) { onPick(LaneFilter.FollowUps) }
        Lane.entries.forEach { l -> FilterChip(l.label, lanes?.count(l), filter == LaneFilter.One(l)) { onPick(LaneFilter.One(l)) } }
    }
}

@Composable
internal fun FilterChip(label: String, count: Int?, selected: Boolean, onClick: () -> Unit) {
    val c = Lp.colors
    val haptics = rememberHaptics()
    val interaction = remember { MutableInteractionSource() }
    val fill by animateColorAsState(if (selected) (if (c.isDark) c.fg else c.acc) else Color.Transparent, label = "chip")
    val ink by animateColorAsState(if (selected) (if (c.isDark) c.page else c.onAcc) else c.fg, label = "ink")
    Row(
        Modifier.heightIn(min = LpSpacing.Touch).pressScale(interaction).glass().background(fill, LpShapes.Pill)
            .clickable(interaction, LocalIndication.current, role = Role.Tab) { if (!selected) haptics.tick(); onClick() }
            .semantics { this.selected = selected }.padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(label, style = LpType.Row.copy(fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal), color = ink, maxLines = 1)
        if (count != null) Text(count.toString(), style = LpType.Row.copy(fontFamily = LpDisplay, fontWeight = FontWeight.Bold), color = if (selected) ink else c.soft, maxLines = 1)
    }
}

@Composable
internal fun StorePill(label: String, onClick: () -> Unit) {
    val c = Lp.colors
    Row(
        Modifier.heightIn(min = LpSpacing.Touch).widthIn(max = 260.dp).glass()
            .clickable(role = Role.DropdownList, onClick = onClick).semantics { contentDescription = "Store: $label" }.padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        LpIcon(LpIcons.Store, null, size = 20.dp, tint = c.fg)
        Text(label, style = LpType.Body, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        LpIcon(LpIcons.ChevronDown, null, size = 20.dp, tint = c.soft)
    }
}

@Composable
private fun SortControl(sort: WoSort, closed: Boolean, onPick: (WoSort) -> Unit) {
    val c = Lp.colors
    var open by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier.heightIn(min = LpSpacing.Touch).clip(LpShapes.Pill).clickable(enabled = !closed, role = Role.DropdownList) { open = true }
                .semantics { role = Role.DropdownList; contentDescription = "Sort: ${sort.label}" }.padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(sort.label, style = LpType.Body, color = c.soft, maxLines = 1)
            if (!closed) LpIcon(LpIcons.ChevronDown, null, size = 20.dp, tint = c.soft)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = c.surf2) {
            listOf(WoSort.Status, WoSort.Updated).forEach { s ->
                DropdownMenuItem(
                    text = { Text(s.label, style = LpType.Body, color = c.fg) }, onClick = { open = false; onPick(s) },
                    trailingIcon = if (s == sort) ({ LpIcon(LpIcons.Check, null, size = 20.dp, tint = c.fg) }) else null,
                )
            }
        }
    }
}

/** The empty right pane on wide screens before a work order is picked. */
@Composable
fun NoSelection() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        LpIcon(LpIcons.Orders, "No work order selected", size = 48.dp, tint = Lp.colors.outline)
    }
}

