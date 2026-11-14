package dev.aethernet.linkpearl.feature.retrace

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.design.AsOfLine
import dev.aethernet.linkpearl.core.design.ChoiceRow
import dev.aethernet.linkpearl.core.design.Fmt
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpBottomSheet
import dev.aethernet.linkpearl.core.design.LpChip
import dev.aethernet.linkpearl.core.design.LpIcon
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpSegmented
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.design.NoticeLine
import dev.aethernet.linkpearl.core.design.StateMessage
import dev.aethernet.linkpearl.core.design.Tone
import dev.aethernet.linkpearl.core.nav.LocalAdaptive
import dev.aethernet.linkpearl.feature.workorders.IconBadge
import dev.aethernet.linkpearl.feature.workorders.LoadView
import dev.aethernet.linkpearl.feature.workorders.LocalWoClock
import dev.aethernet.linkpearl.feature.workorders.OutlineButton
import dev.aethernet.linkpearl.feature.workorders.Problem
import dev.aethernet.linkpearl.feature.workorders.SearchField
import dev.aethernet.linkpearl.feature.workorders.SkeletonRow
import dev.aethernet.linkpearl.feature.workorders.StorePill
import dev.aethernet.linkpearl.feature.workorders.WoFmt
import dev.aethernet.linkpearl.feature.workorders.canRetry
import dev.aethernet.linkpearl.feature.workorders.problemText
import dev.aethernet.linkpearl.feature.workorders.rememberTwoColumnCells
import dev.aethernet.linkpearl.feature.workorders.twoColumnGap
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter

data class RetraceActions(
    val onQuery: (String) -> Unit = {},
    val onClearQuery: () -> Unit = {},
    val onPickStore: (Int) -> Unit = {},
    val onPickView: (RetraceView) -> Unit = {},
    val onRefresh: () -> Unit = {},
    val onLoadMore: () -> Unit = {},
    val onOpenItem: (RtItemRow) -> Unit = {},
    val onOpenLabel: (RtLabelHit) -> Unit = {},
)

/**
 * Retrace home, stateless: title, search (item, name, SKU or label), the Items / Purchase orders switch, the store and the "As of" of the
 * last sweep, then the list. Wide screens (600dp and up): cards in two columns, split on the fold when there is one.
 */
@Composable
fun RetraceScreen(
    state: RetraceUi,
    modifier: Modifier = Modifier,
    selectedItem: String? = null,
    actions: RetraceActions = RetraceActions(),
    twoColumns: Boolean = false,
) {
    val zone = LocalWoClock.current.zone
    var originX by remember { mutableFloatStateOf(0f) }
    var storeMenu by remember { mutableStateOf(false) }
    val gridState = rememberLazyGridState()
    val hinge = LocalAdaptive.current.hinge
    val cells: GridCells = if (twoColumns) rememberTwoColumnCells(hinge, originX) else GridCells.Fixed(1)
    val colGap = if (twoColumns) twoColumnGap(hinge) else 0.dp
    val onLoadMore by rememberUpdatedState(actions.onLoadMore)
    LaunchedEffect(gridState) {
        snapshotFlow { gridState.layoutInfo.let { it.totalItemsCount > 0 && (it.visibleItemsInfo.lastOrNull()?.index ?: 0) >= it.totalItemsCount - 4 } }
            .distinctUntilChanged().filter { it }.collect { onLoadMore() }
    }

    Column(modifier.fillMaxSize().onGloballyPositioned { originX = it.positionInWindow().x }) {
        Column(Modifier.padding(horizontal = LpSpacing.Gutter).padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
            Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Retrace", style = LpType.Title.copy(fontWeight = FontWeight.Bold), color = Lp.colors.fg, modifier = Modifier.weight(1f).semantics { heading() }, maxLines = 1)
            }
            SearchField(state.query, true, actions.onQuery, actions.onClearQuery, {}, placeholder = "Item, name, SKU, label")
            LpSegmented(listOf("Items", "Purchase orders"), if (state.view == RetraceView.Items) 0 else 1, { actions.onPickView(RetraceView.entries[it]) })
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StorePill(state.storeName(state.store)) { storeMenu = true }
                Box(Modifier.weight(1f))
                if (state.asOf != null) AsOfLine("As of " + Fmt.clock(state.asOf, zone.id))
            }
        }
        when (state.load) {
            LoadView.Loading -> Column(Modifier.padding(LpSpacing.Gutter), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) { repeat(4) { SkeletonRow() } }
            LoadView.Error -> StateMessage(problemText(state.problem), actionLabel = if (canRetry(state.problem)) "Retry" else null, onAction = actions.onRefresh)
            LoadView.Ok -> PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = actions.onRefresh, modifier = Modifier.fillMaxSize()) {
                LazyVerticalGrid(
                    columns = cells, state = gridState, modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(start = LpSpacing.Gutter, end = LpSpacing.Gutter, top = LpSpacing.M, bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(LpSpacing.M), horizontalArrangement = Arrangement.spacedBy(colGap),
                ) {
                    state.problem?.let { p ->
                        item(key = "banner", span = { GridItemSpan(maxLineSpan) }) {
                            if (p == Problem.Offline) NoticeLine(problemText(p), LpIcons.WifiOff, Modifier.fillMaxWidth())
                            else NoticeLine(problemText(p), LpIcons.Warning, Modifier.fillMaxWidth(), warn = true, actionLabel = if (canRetry(p)) "Retry" else null, onAction = actions.onRefresh)
                        }
                    }
                    if (state.view == RetraceView.Items) {
                        items(state.labels, key = { "l" + it.label }) { LabelHitCard(it) { actions.onOpenLabel(it) } }
                        items(state.items, key = { "i" + it.item }) { ItemCard(it, selectedItem == it.item) { actions.onOpenItem(it) } }
                        if (state.items.isEmpty() && state.labels.isEmpty() && state.problem == null) item(key = "empty", span = { GridItemSpan(maxLineSpan) }) { Empty(state.query.trim(), actions.onClearQuery) }
                    } else {
                        items(state.pos, key = { "p" + it.po }) { PoCard(it) }
                        if (state.pos.isEmpty() && state.problem == null) item(key = "empty", span = { GridItemSpan(maxLineSpan) }) { Empty("", {}) }
                    }
                    if (state.loadingMore) item(key = "more", span = { GridItemSpan(maxLineSpan) }) { SkeletonRow() }
                }
            }
        }
    }

    if (storeMenu) {
        LpBottomSheet(onDismiss = { storeMenu = false }) {
            state.stores.forEach { s -> ChoiceRow(s.label, state.store == s.id, { storeMenu = false; actions.onPickStore(s.id) }) }
        }
    }
}

/** "No match for 1762" with Clear while searching; just the icon when the store has nothing to list. */
@Composable
private fun Empty(query: String, onClear: () -> Unit) {
    val c = Lp.colors
    Column(Modifier.fillMaxWidth().padding(horizontal = LpSpacing.L, vertical = 40.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(LpSpacing.L)) {
        if (query.isNotEmpty()) {
            IconBadge(LpIcons.Search, size = 80.dp, tint = c.warn, background = c.warnBg)
            Text("No match for $query", style = LpType.Row.copy(fontWeight = FontWeight.SemiBold), color = c.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
            OutlineButton("Clear", null, onClear)
        } else IconBadge(LpIcons.Package, size = 80.dp)
    }
}

/** An item: name, item number and last movement, Available and On hand. */
@Composable
fun ItemCard(item: RtItemRow, selected: Boolean, onClick: () -> Unit) {
    val c = Lp.colors
    val shape = LpShapes.Card
    Column(
        Modifier.fillMaxWidth().clip(shape).background(if (selected) c.accSoft else c.surf).border(if (selected) 2.dp else 1.dp, if (selected) c.acc else c.line, shape)
            .clickable(role = Role.Button, onClick = onClick).padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(item.name ?: Fmt.DASH, style = LpType.Row.copy(fontWeight = FontWeight.SemiBold), color = c.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(item.item, style = LpType.Body, color = c.soft, modifier = Modifier.weight(1f), maxLines = 1)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                LpIcon(LpIcons.Clock, null, size = 20.dp, tint = c.soft)
                Text(WoFmt.shortDayTime(item.lastAt, LocalWoClock.current.zone), style = LpType.Small, color = c.soft, maxLines = 1)
            }
        }
        Box(Modifier.fillMaxWidth().padding(vertical = 4.dp).height(1.dp).background(c.line))
        Row {
            Stat("Available", Fmt.count(item.available), Modifier.weight(1f))
            Stat("On hand", Fmt.count(item.onHand), Modifier.weight(1f))
        }
    }
}

@Composable
private fun Stat(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(label, style = LpType.Small, color = Lp.colors.soft)
        Text(value, style = LpType.ValueMedium, color = Lp.colors.fg, maxLines = 1)
    }
}

/** A label found by the search: the label, its status now, its item. */
@Composable
fun LabelHitCard(hit: RtLabelHit, onClick: () -> Unit) {
    val c = Lp.colors
    val shape = LpShapes.Card
    val group = NowGroup.of(hit.group)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(c.surf).border(1.dp, c.line, shape).clickable(role = Role.Button, onClick = onClick).padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(hit.label, style = LpType.ValueMedium, color = c.fg, maxLines = 1)
        Text(hit.name ?: Fmt.DASH, style = LpType.Row, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
        NowChip(hit.now, group)
    }
}

/** A purchase order: number and date, counterpart and total, status and labels received of total. */
@Composable
fun PoCard(po: RtPoRow) {
    val c = Lp.colors
    val shape = LpShapes.Card
    Column(
        Modifier.fillMaxWidth().clip(shape).background(c.surf).border(1.dp, c.line, shape).padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(po.po, style = LpType.ValueMedium, color = c.fg, modifier = Modifier.weight(1f), maxLines = 1)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                LpIcon(LpIcons.Calendar, null, size = 20.dp, tint = c.soft)
                Text(WoFmt.shortDayTime(po.date, LocalWoClock.current.zone).substringBefore(Fmt.DOT), style = LpType.Body, color = c.soft, maxLines = 1)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(po.counterpart ?: Fmt.DASH, style = LpType.Row, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text(WoFmt.money(po.total), style = LpType.BodyStrong, color = c.fg, maxLines = 1, modifier = Modifier.padding(start = 8.dp))
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            PoStatusChip(po.status)
            Text(receivedText(po), style = LpType.Body, color = c.fg, maxLines = 1)
        }
    }
}

/** "3 of 8 received"; "3 received" when the label count is not known; a dash when neither is. */
fun receivedText(po: RtPoRow): String = when {
    po.received != null && po.labels != null -> "${po.received} of ${po.labels} received"
    po.received != null -> "${po.received} received"
    else -> Fmt.DASH
}

/** Portal's status text as given; only the few known ones get an icon and colour (Received / Invoiced, Draft, anything cancelled). */
@Composable
fun PoStatusChip(status: String?, modifier: Modifier = Modifier) {
    val s = status?.trim().orEmpty()
    val l = s.lowercase()
    when {
        s.isEmpty() -> Unit
        l == "received" || l == "invoiced" -> LpChip(s, modifier, Tone.Good, LpIcons.Check)
        l.contains("cancel") -> LpChip(s, modifier, Tone.Warn, LpIcons.Close)
        else -> LpChip(s, modifier, Tone.Neutral)
    }
}
