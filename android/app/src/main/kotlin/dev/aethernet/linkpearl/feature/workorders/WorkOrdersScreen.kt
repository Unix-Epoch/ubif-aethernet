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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpBottomSheet
import dev.aethernet.linkpearl.core.design.LpIcon
import dev.aethernet.linkpearl.core.design.LpIconButton
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpShapes
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
) {
    val nowMs = rememberNowMs(state.skewMs)
    var storeMenu by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val onLoadMore by rememberUpdatedState(actions.onLoadMore)
    LaunchedEffect(listState) {
        snapshotFlow { listState.layoutInfo.let { it.totalItemsCount > 0 && (it.visibleItemsInfo.lastOrNull()?.index ?: 0) >= it.totalItemsCount - 4 } }
            .distinctUntilChanged().filter { it }.collect { onLoadMore() }
    }
    val search = state.search

    Column(modifier.fillMaxSize()) {
        Column(Modifier.padding(horizontal = LpSpacing.Gutter).padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
            Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Work orders", style = LpType.Title.copy(fontWeight = FontWeight.Bold), color = Lp.colors.fg, modifier = Modifier.weight(1f).semantics { heading() }, maxLines = 1)
                LockControl(state.unlocked, remaining, actions.onUnlock, actions.onLock)
            }
            SearchField(state.query, state.unlocked, actions.onQuery, actions.onClearQuery, actions.onUnlock)
            if (search == null) {
                LaneChips(state.lanes, state.filter, actions.onPickFilter)
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    StorePill(if (state.store == null) "All stores" else state.storeName(state.store)) { storeMenu = true }
                    Spacer(Modifier.weight(1f))
                    SortControl(state.sort, state.filter == LaneFilter.Closed, actions.onPickSort)
                }
            }
        }

        if (search != null) {
            SearchResults(state, search, nowMs, selected, actions)
        } else {
            when (state.view) {
                LoadView.Loading -> Column(Modifier.padding(LpSpacing.Gutter), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) { repeat(4) { SkeletonRow() } }
                LoadView.Error -> StateMessage(problemText(state.problem), actionLabel = if (canRetry(state.problem)) "Retry" else null, onAction = actions.onRefresh)
                LoadView.Ok -> PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = actions.onRefresh, modifier = Modifier.fillMaxSize()) {
                    LazyColumn(
                        state = listState, modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(start = LpSpacing.Gutter, end = LpSpacing.Gutter, top = LpSpacing.M, bottom = 24.dp),
                        verticalArrangement = Arrangement.spacedBy(LpSpacing.M),
                    ) {
                        state.problem?.let { p ->
                            item(key = "banner") {
                                val at = state.receivedAtMs?.let { java.time.Instant.ofEpochMilli(it).toString() }
                                val clock = Fmt.clock(at, LocalWoClock.current.zone.id)
                                when (p) {
                                    Problem.Offline -> NoticeLine(Fmt.offline(clock), LpIcons.WifiOff, Modifier.fillMaxWidth())
                                    else -> NoticeLine(problemText(p), LpIcons.Warning, Modifier.fillMaxWidth(), warn = true, actionLabel = if (canRetry(p)) "Retry" else null, onAction = actions.onRefresh)
                                }
                            }
                        }
                        if (state.rows.isEmpty()) item(key = "empty") { EmptyLane() }
                        items(state.rows, key = { it.key.id }) { row ->
                            WoRowCard(row, state, nowMs, selected == row.key) { actions.onOpen(row) }
                        }
                        if (state.loadingMore) item(key = "more") { SkeletonRow() }
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

@Composable
private fun SearchResults(state: WoListUi, search: SearchUi, nowMs: Long, selected: WoKey?, actions: WoListActions) {
    when {
        search.busy -> Column(Modifier.padding(LpSpacing.Gutter), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) { repeat(2) { SkeletonRow() } }
        search.results.isNotEmpty() -> LazyColumn(
            Modifier.fillMaxSize(), contentPadding = PaddingValues(start = LpSpacing.Gutter, end = LpSpacing.Gutter, top = LpSpacing.M, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(LpSpacing.M),
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

/** One work order card: number and time in status; device and program; status chip and store; the customer line. */
@Composable
fun WoRowCard(row: WoRow, state: WoListUi, nowMs: Long, selected: Boolean, showStoreAlways: Boolean = false, onClick: () -> Unit) {
    val c = Lp.colors
    val name = state.names[row.key]
    val shape = LpShapes.Card
    Column(
        Modifier.fillMaxWidth().clip(shape).background(if (selected) c.accSoft else c.surf).border(if (selected) 2.dp else 1.dp, if (selected) c.acc else c.line, shape)
            .clickable(role = Role.Button, onClick = onClick).semantics { this.selected = selected }
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(row.wo.toString(), style = LpType.ValueMedium, color = c.fg, modifier = Modifier.weight(1f), maxLines = 1)
            if (row.open) TimeInStatus(row.statusSince, nowMs) else Text(WoFmt.shortDayTime(row.closedAt, LocalWoClock.current.zone), style = LpType.Small, color = c.soft)
        }
        val sub = listOfNotNull(row.device, row.program).joinToString(Fmt.DOT).ifEmpty { Fmt.DASH }
        Text(sub, style = LpType.Row, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            StatusChip(row.status, row.lane)
            if (state.showStore || showStoreAlways) Text(state.storeName(row.store), style = LpType.Small, color = c.soft, maxLines = 1, overflow = TextOverflow.Ellipsis,
                textAlign = androidx.compose.ui.text.style.TextAlign.End, modifier = Modifier.weight(1f, fill = false).padding(start = 8.dp))
        }
        Box(Modifier.fillMaxWidth().padding(vertical = 4.dp).height(1.dp).background(c.line))
        Row(Modifier.heightIn(min = 28.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            when {
                !state.unlocked -> {
                    LpIcon(LpIcons.Lock, "Customer locked", size = 20.dp, tint = c.soft)
                    Bar(92.dp, height = 10.dp)
                }
                name != null -> {
                    LpIcon(WoIcons.Person, null, size = 20.dp, tint = c.fg)
                    Text(name, style = LpType.Body, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                row.store in state.noKeyStores -> {
                    LpIcon(LpIcons.Lock, null, size = 20.dp, tint = c.soft)
                    Text("No key", style = LpType.Small, color = c.soft)
                }
                else -> {
                    LpIcon(WoIcons.Person, null, size = 20.dp, tint = c.soft)
                    Text(Fmt.DASH, style = LpType.Body, color = c.soft)
                }
            }
        }
    }
}

@Composable
private fun SkeletonRow() {
    Column(
        Modifier.fillMaxWidth().background(Lp.colors.surf, LpShapes.Card).border(1.dp, Lp.colors.line, LpShapes.Card).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row { Skeleton(width = 130.dp, height = 20.dp); Spacer(Modifier.weight(1f)); Skeleton(width = 60.dp) }
        Skeleton(width = 190.dp)
        Skeleton(width = 120.dp, height = 22.dp)
    }
}

/** The search field. Locked: "Number" plus a lock chip for name / phone / IMEI (tapping it starts unlocking). */
@Composable
fun SearchField(query: String, unlocked: Boolean, onQuery: (String) -> Unit, onClear: () -> Unit, onUnlock: () -> Unit, modifier: Modifier = Modifier) {
    val c = Lp.colors
    Row(
        modifier.fillMaxWidth().heightIn(min = 56.dp).clip(LpShapes.Pill).background(c.surf3).border(1.5.dp, c.outline, LpShapes.Pill).padding(start = 18.dp, end = 6.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        LpIcon(LpIcons.Search, null, tint = c.fg)
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
            if (query.isEmpty()) Text(if (unlocked) "Number, name, phone, IMEI" else "Number", style = LpType.Row, color = c.soft, maxLines = 1, overflow = TextOverflow.Ellipsis)
            BasicTextField(
                value = query, onValueChange = onQuery, singleLine = true,
                textStyle = LpType.Row.copy(color = c.fg), cursorBrush = SolidColor(c.acc),
                // Locked: digits only (number lookup). Unlocked: any text, never auto-corrected or learned by the keyboard.
                keyboardOptions = KeyboardOptions(keyboardType = if (unlocked) KeyboardType.Text else KeyboardType.Number, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = if (unlocked) "Search number, name, phone or IMEI" else "Search number" },
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
private fun LaneChips(lanes: WoLanes?, filter: LaneFilter, onPick: (LaneFilter) -> Unit) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilterChip("All", lanes?.total, filter == LaneFilter.All) { onPick(LaneFilter.All) }
        Lane.entries.forEach { l -> FilterChip(l.label, lanes?.count(l), filter == LaneFilter.One(l)) { onPick(LaneFilter.One(l)) } }
        FilterChip("Closed", null, filter == LaneFilter.Closed) { onPick(LaneFilter.Closed) }
    }
}

@Composable
private fun FilterChip(label: String, count: Int?, selected: Boolean, onClick: () -> Unit) {
    val c = Lp.colors
    Row(
        Modifier.heightIn(min = LpSpacing.Touch).clip(LpShapes.Row).let { if (selected) it.background(c.accSoft) else it.border(1.5.dp, c.outline, LpShapes.Row) }
            .clickable(role = Role.Tab, onClick = onClick).semantics { this.selected = selected }.padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (selected) LpIcon(LpIcons.Check, null, size = 18.dp, tint = c.onAccSoft)
        Text(if (count != null) "$label $count" else label, style = LpType.Row.copy(fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal), color = if (selected) c.onAccSoft else c.fg, maxLines = 1)
    }
}

@Composable
private fun StorePill(label: String, onClick: () -> Unit) {
    val c = Lp.colors
    Row(
        Modifier.heightIn(min = LpSpacing.Touch).widthIn(max = 260.dp).clip(LpShapes.Row).border(1.5.dp, c.line, LpShapes.Row)
            .clickable(role = Role.DropdownList, onClick = onClick).semantics { contentDescription = "Store: $label" }.padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        LpIcon(LpIcons.Store, null, size = 20.dp, tint = c.fg)
        Text(label, style = LpType.Body, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        LpIcon(LpIcons.ChevronDown, null, size = 20.dp, tint = c.fg)
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

