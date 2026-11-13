package dev.aethernet.linkpearl.feature.alerts

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
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
import dev.aethernet.linkpearl.core.nav.LocalAdaptive
import dev.aethernet.linkpearl.core.nav.LpListDetail

/** Compatibility entry (the nav chrome screenshot test draws it without state): the empty, loaded feed. */
@Composable
fun AlertsScreen(modifier: Modifier = Modifier) =
    AlertsContent(FeedUi(loaded = true), emptyMap(), emptyList(), notificationsOn = true, settings = SettingsUi.Loading, actions = AlertsActions(), modifier = modifier)

/** Everything the Alerts screen can ask for; the stateful route fills these in, screenshot tests leave them empty. */
data class AlertsActions(
    val onRefresh: () -> Unit = {},
    val onLoadMore: () -> Unit = {},
    val onStore: (Int?) -> Unit = {},
    val onUnreadOnly: (Boolean) -> Unit = {},
    val onMarkAll: () -> Unit = {},
    val onMarkRead: (Int) -> Unit = {},
    val onOpenSettings: () -> Unit = {},
    val onTurnOnNotifications: () -> Unit = {},
    val onOpenWorkOrder: (Long) -> Unit = {},
    val onEdit: (SettingsEdit) -> Unit = {},
)

/**
 * Alerts: on phones one pane at a time (work-order alerts open the work order, store-level ones a small detail pane); from 600dp the
 * list is on the left and the selected alert's detail on the right, with that alert's own switch and threshold.
 */
@Composable
fun AlertsContent(
    ui: FeedUi,
    names: Map<Int, String>,
    storeIds: List<Int>,
    notificationsOn: Boolean,
    settings: SettingsUi,
    actions: AlertsActions,
    modifier: Modifier = Modifier,
    initialSelection: Int? = null,
    editorStyle: EditorStyle? = null,
    initialEditing: Boolean = false,
) {
    val compact = LocalAdaptive.current.isCompact
    var selectedId by remember { mutableStateOf(initialSelection) }
    LpListDetail<Int>(
        modifier = modifier, initialSelection = initialSelection,
        list = { select ->
            AlertsListPane(
                ui, names, storeIds, notificationsOn, actions, selectedId = if (compact) null else selectedId,
                onTap = { a ->
                    if (!a.read) actions.onMarkRead(a.id)
                    if (a.wo != null && compact) actions.onOpenWorkOrder(a.wo) else { selectedId = a.id; select(a.id) }
                },
            )
        },
        detail = { id ->
            val a = ui.alerts.firstOrNull { it.id == id }
            if (a != null) AlertDetail(a, names, settings, actions, editorStyle ?: if (compact) EditorStyle.Sheet else EditorStyle.InPane, initialEditing)
        },
        emptyDetail = { Box(Modifier.fillMaxSize()) },
    )
}

private sealed interface Item {
    data class Header(val text: String) : Item
    data class Entry(val alert: Alert, val first: Boolean, val last: Boolean) : Item
}

private fun items(ui: FeedUi): List<Item> {
    val now = ui.now ?: java.time.Instant.now().toString()
    return groupByDay(ui.visible, now).flatMap { g ->
        listOf<Item>(Item.Header(g.heading)) + g.alerts.mapIndexed { i, a -> Item.Entry(a, i == 0, i == g.alerts.lastIndex) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AlertsListPane(
    ui: FeedUi,
    names: Map<Int, String>,
    storeIds: List<Int>,
    notificationsOn: Boolean,
    actions: AlertsActions,
    selectedId: Int?,
    onTap: (Alert) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = Lp.colors
    var chooser by remember { mutableStateOf(false) }
    Column(modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = LpSpacing.Gutter, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Alerts", style = LpType.Title, color = c.fg, modifier = Modifier.weight(1f).padding(vertical = 8.dp).semantics { heading() })
            LpIconButton(LpIcons.Sliders, "Alert settings", actions.onOpenSettings)
        }
        Column(Modifier.padding(horizontal = LpSpacing.Gutter), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (!notificationsOn) NoticeLine("Notifications are off", AlertIcons.BellOff, warn = true, actionLabel = "Turn on", onAction = actions.onTurnOnNotifications)
            if (ui.loaded) when (ui.status) {
                FeedStatus.Offline -> NoticeLine(Fmt.offline(Fmt.clock(ui.loadedAt, AlertText.TZ)), LpIcons.WifiOff)
                FeedStatus.Error -> NoticeLine(Fmt.couldntRefresh(Fmt.clock(ui.loadedAt, AlertText.TZ)), LpIcons.Warning, warn = true, actionLabel = "Retry", onAction = actions.onRefresh)
                else -> {}
            }
            if (ui.error != null) NoticeLine(ui.error, LpIcons.Warning, warn = true)
        }
        val showChips = ui.loaded && (ui.alerts.isNotEmpty() || ui.store != null)
        if (showChips) {
            val unreadCount = ui.unread.takeIf { ui.store == null } ?: ui.alerts.count { !it.read }
            FlowRow(
                Modifier.fillMaxWidth().padding(horizontal = LpSpacing.Gutter, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp), itemVerticalAlignment = Alignment.CenterVertically,
            ) {
                FilterChip(
                    text = ui.store?.let { Fmt.storeLabel(it, names[it]).substringBefore(" #").ifBlank { "#$it" } } ?: "All stores",
                    active = true, icon = if (ui.store == null) LpIcons.Check else LpIcons.Store, trailing = LpIcons.ChevronDown, onClick = { chooser = true },
                    description = "Store filter",
                )
                FilterChip(text = "Unread $unreadCount", active = ui.unreadOnly, icon = if (ui.unreadOnly) LpIcons.Check else null, onClick = { actions.onUnreadOnly(!ui.unreadOnly) }, description = "Unread only")
                if (unreadCount > 0) Box(
                    Modifier.heightIn(min = LpSpacing.Touch).clip(LpShapes.Pill).clickable(role = Role.Button, onClick = actions.onMarkAll).padding(horizontal = 12.dp),
                    contentAlignment = Alignment.Center,
                ) { Text("Mark all read", style = LpType.BodyStrong, color = c.accText) }
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                ui.status == FeedStatus.SignedOut -> StateMessage("Signed out")
                !ui.loaded && (ui.status == FeedStatus.Error || ui.status == FeedStatus.NotConfigured) -> StateMessage("Couldn't load", actionLabel = "Retry", onAction = actions.onRefresh)
                !ui.loaded && ui.status == FeedStatus.Offline -> StateMessage("Offline", actionLabel = "Retry", onAction = actions.onRefresh)
                !ui.loaded -> Column(Modifier.padding(horizontal = LpSpacing.Gutter, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    repeat(5) { Skeleton(Modifier.fillMaxWidth(), height = 72.dp, shape = LpShapes.Row) }
                }
                ui.alerts.isEmpty() -> Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(20.dp, Alignment.CenterVertically)) {
                    Box(Modifier.padding(top = 24.dp).background(c.infoBg, CircleShape).padding(28.dp)) { LpIcon(AlertIcons.BellOff, null, size = 40.dp, tint = c.info) }
                    Text("No alerts yet", style = LpType.Title, color = c.fg)
                    PillButton("Alert settings", actions.onOpenSettings, tonal = true)
                }
                ui.visible.isEmpty() -> StateMessage("No unread alerts")
                else -> FeedList(ui, names, selectedId, actions, onTap)
            }
        }
    }
    if (chooser) LpBottomSheet({ chooser = false }) {
        ChoiceRow("All stores", ui.store == null, { actions.onStore(null); chooser = false })
        storeIds.forEach { id -> ChoiceRow(Fmt.storeLabel(id, names[id]), ui.store == id, { actions.onStore(id); chooser = false }) }
    }
}

@Composable
private fun FeedList(ui: FeedUi, names: Map<Int, String>, selectedId: Int?, actions: AlertsActions, onTap: (Alert) -> Unit) {
    val c = Lp.colors
    val list = remember(ui.visible, ui.now) { items(ui) }
    val state = rememberLazyListState()
    LaunchedEffect(state, list.size, ui.more) {
        snapshotFlow { state.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }.collect { last -> if (ui.more && last >= list.size - 4) actions.onLoadMore() }
    }
    PullToRefreshBox(isRefreshing = ui.refreshing, onRefresh = actions.onRefresh, modifier = Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), state = state, contentPadding = androidx.compose.foundation.layout.PaddingValues(start = LpSpacing.Gutter, end = LpSpacing.Gutter, bottom = 24.dp)) {
            list.forEach { item ->
                when (item) {
                    is Item.Header -> item(key = "h-${item.text}") {
                        Text(item.text.uppercase(), style = LpType.Label, color = c.soft, modifier = Modifier.padding(start = 8.dp, top = 16.dp, bottom = 8.dp).semantics { heading() })
                    }
                    is Item.Entry -> item(key = item.alert.id) {
                        val r = 20.dp
                        val shape = RoundedCornerShape(topStart = if (item.first) r else 0.dp, topEnd = if (item.first) r else 0.dp, bottomStart = if (item.last) r else 0.dp, bottomEnd = if (item.last) r else 0.dp)
                        Column(Modifier.background(c.surf, shape)) {
                            if (!item.first) Hairline()
                            AlertRow(item.alert, names, shape, selected = item.alert.id == selectedId, onClick = { onTap(item.alert) })
                        }
                    }
                }
            }
            if (ui.loadingMore) item(key = "more") { Skeleton(Modifier.fillMaxWidth().padding(top = 12.dp), height = 72.dp, shape = LpShapes.Row) }
        }
    }
}

@Composable
private fun FilterChip(
    text: String, active: Boolean, onClick: () -> Unit, description: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector? = null, trailing: androidx.compose.ui.graphics.vector.ImageVector? = null,
) {
    val c = Lp.colors
    val shape = LpShapes.Pill
    Box(Modifier.heightIn(min = LpSpacing.Touch), contentAlignment = Alignment.Center) {
        Row(
            Modifier.heightIn(min = 40.dp).clip(shape)
                .background(if (active) c.accSoft else androidx.compose.ui.graphics.Color.Transparent, shape)
                .let { if (active) it else it.border(1.5.dp, c.outline, shape) }
                .clickable(role = Role.Button, onClick = onClick)
                .semantics { this.selected = active; contentDescription = "$description, $text" }
                .padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (icon != null) LpIcon(icon, null, size = 20.dp, tint = if (active) c.onAccSoft else c.fg)
            Text(text, style = LpType.BodyStrong, color = if (active) c.onAccSoft else c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 180.dp))
            if (trailing != null) LpIcon(trailing, null, size = 20.dp, tint = if (active) c.onAccSoft else c.fg)
        }
    }
}

/** The right pane: the facts of one alert, its own switch and threshold, and the work order button when there is one. */
@Composable
fun AlertDetail(
    alert: Alert,
    names: Map<Int, String>,
    settings: SettingsUi,
    actions: AlertsActions,
    editorStyle: EditorStyle,
    initialEditing: Boolean = false,
) {
    val c = Lp.colors
    var editing by remember { mutableStateOf(initialEditing) }
    val settingType = if (alert.type == AlertType.Back) AlertType.Quiet else alert.type
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = LpSpacing.Gutter, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(LpSpacing.L)) {
            Text(AlertText.sentence(alert, names), style = LpType.Title, color = c.fg, modifier = Modifier.padding(top = 8.dp).semantics { heading() })
            Text(AlertText.meta(alert, names), style = LpType.Small, color = c.soft)
            GroupCard {
                AlertText.facts(alert, names).forEachIndexed { i, (k, v) ->
                    if (i > 0) Hairline()
                    Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = LpSpacing.L, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(k, style = LpType.Body, color = c.soft, modifier = Modifier.weight(1f))
                        Text(v, style = LpType.BodyStrong, color = c.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            if (alert.type.configurable || alert.type == AlertType.Back) {
                Text("This alert", style = LpType.Label, color = c.soft, modifier = Modifier.padding(start = 8.dp).semantics { heading() })
                when (settings) {
                    is SettingsUi.Ready -> settings.bundle.settings.types[settingType]?.let { ts ->
                        GroupCard { TypeSettingRow(settingType, ts, { actions.onEdit(SettingsEdit.TypeOn(settingType, it)) }, { editing = true }) }
                        if (settings.error != null) NoticeLine(settings.error, LpIcons.Warning, warn = true)
                    }
                    SettingsUi.Loading -> Skeleton(Modifier.fillMaxWidth(), height = 72.dp, shape = LpShapes.Row)
                    is SettingsUi.Failed -> {}
                }
            }
            if (alert.wo != null) PillButton("Open work order", { actions.onOpenWorkOrder(alert.wo) }, Modifier.fillMaxWidth(), icon = LpIcons.External)
        }
        val ready = settings as? SettingsUi.Ready
        val cur = ready?.bundle?.settings?.types?.get(settingType)
        if (editing && ready != null && cur != null) {
            ThresholdEditor(settingType, cur.value, ready.bundle.ranges.of(settingType), editorStyle,
                onSave = { actions.onEdit(SettingsEdit.TypeValue(settingType, it)); editing = false }, onDismiss = { editing = false })
        }
    }
}
