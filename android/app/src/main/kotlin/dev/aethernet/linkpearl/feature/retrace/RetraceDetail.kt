package dev.aethernet.linkpearl.feature.retrace

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.design.CardLabel
import dev.aethernet.linkpearl.core.design.Fmt
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpCard
import dev.aethernet.linkpearl.core.design.LpChip
import dev.aethernet.linkpearl.core.design.LpIcon
import dev.aethernet.linkpearl.core.design.LpIconButton
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.design.Skeleton
import dev.aethernet.linkpearl.core.design.StateMessage
import dev.aethernet.linkpearl.core.design.Tone
import dev.aethernet.linkpearl.core.design.bg
import dev.aethernet.linkpearl.core.design.fg
import dev.aethernet.linkpearl.feature.workorders.LabelValue
import dev.aethernet.linkpearl.feature.workorders.LoadView
import dev.aethernet.linkpearl.feature.workorders.LocalWoClock
import dev.aethernet.linkpearl.feature.workorders.TimelineRow
import dev.aethernet.linkpearl.feature.workorders.TimelineRows
import dev.aethernet.linkpearl.feature.workorders.WoFmt
import dev.aethernet.linkpearl.feature.workorders.canRetry
import dev.aethernet.linkpearl.feature.workorders.problemText

/** What a Retrace detail can ask for. */
data class RetraceDetailActions(
    val onBack: () -> Unit = {},
    val onRetry: () -> Unit = {},
    /** An item's label opens that label. */
    val onOpenLabel: (String) -> Unit = {},
    /** A work order reference (a label's linked WO, a movement's WO) opens that work order in the existing Work orders detail. */
    val onOpenWo: (String) -> Unit = {},
)

/** The top bar both Retrace details share: back (or close in the wide panel) and the number. */
@Composable
private fun DetailBar(title: String, showBack: Boolean, closeIcon: Boolean, onBack: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(start = if (showBack) 4.dp else LpSpacing.Gutter, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        if (showBack) LpIconButton(if (closeIcon) LpIcons.Close else LpIcons.Back, if (closeIcon) "Close" else "Back", onBack)
        Text(title, style = LpType.Title.copy(fontWeight = FontWeight.Bold), color = Lp.colors.fg, maxLines = 1,
            modifier = Modifier.weight(1f).padding(start = if (showBack) 8.dp else 0.dp).semantics { heading() })
    }
}

/** The status now in words with the group's icon (colour is never alone); a status Retrace does not map is plain text. */
@Composable
fun NowChip(text: String?, group: NowGroup?, modifier: Modifier = Modifier) {
    if (group != null) LpChip(text ?: group.label, modifier, group.tone, group.icon) else LpChip(text ?: Fmt.DASH, modifier, Tone.Neutral)
}

@Composable
private fun Skeletons() {
    Column(Modifier.padding(horizontal = LpSpacing.Gutter), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
        repeat(3) { LpCard { Skeleton(width = 160.dp, height = 24.dp); Spacer(Modifier.height(12.dp)); Skeleton(width = 120.dp); Spacer(Modifier.height(12.dp)); Skeleton(width = 220.dp) } }
    }
}

/** "5 of 120" when the list is cut, else the number. */
private fun countText(shown: Int, total: Int?) = if (total != null && total > shown) "$shown of $total" else shown.toString()

/** An item, stateless: name and count tiles per now-group, its labels, its newest movements. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RetraceItemScreen(
    ui: RtDetailUi<RtItemResponse>, item: String, store: Int, showBack: Boolean, actions: RetraceDetailActions, modifier: Modifier = Modifier, closeIcon: Boolean = false,
) {
    val c = Lp.colors
    val zone = LocalWoClock.current.zone
    Column(modifier.fillMaxSize()) {
        DetailBar(item, showBack, closeIcon, actions.onBack)
        val d = ui.data
        when {
            ui.view == LoadView.Loading && d == null -> Skeletons()
            d == null -> StateMessage(problemText(ui.problem), actionLabel = if (canRetry(ui.problem)) "Retry" else null, onAction = actions.onRetry)
            else -> Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = LpSpacing.Gutter).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
                LpCard {
                    Text(d.info?.name ?: Fmt.DASH, style = LpType.Title.copy(fontWeight = FontWeight.Bold), color = c.fg)
                    Spacer(Modifier.height(4.dp))
                    Text(ui.storeName(store), style = LpType.Body, color = c.soft)
                    Box(Modifier.fillMaxWidth().padding(vertical = 14.dp).height(1.dp).background(c.line))
                    val counts = d.groupCounts()
                    FlowRow(Modifier.fillMaxWidth(), maxItemsInEachRow = 3, horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        NowGroup.entries.forEach { g -> CountTile(g, counts[g] ?: 0, Modifier.weight(1f)) }
                    }
                }
                LpCard {
                    CardLabel("Labels", trailing = { Text(countText(d.labels.size, d.labelsTotal), style = LpType.Label, color = c.soft) })
                    if (d.labels.isEmpty()) { Spacer(Modifier.height(10.dp)); Text(Fmt.DASH, style = LpType.Body, color = c.soft) }
                    d.labels.forEach { l ->
                        Box(Modifier.fillMaxWidth().padding(vertical = 6.dp).height(1.dp).background(c.line))
                        Column(Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = "Open label") { actions.onOpenLabel(l.label) }.padding(vertical = 6.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(l.label, style = LpType.BodyStrong, color = c.fg, modifier = Modifier.weight(1f), maxLines = 1)
                                NowChip(l.now, NowGroup.of(l.group))
                            }
                            Spacer(Modifier.height(4.dp))
                            Text(l.wo?.let { "WO $it" } ?: l.po?.let { "PO $it" } ?: Fmt.DASH, style = LpType.Body, color = c.fg, maxLines = 1)
                            Text(
                                listOfNotNull(l.lastKind?.let { RtKinds.words(it) }, l.lastAt?.let { WoFmt.shortDayTime(it, zone) }).joinToString(Fmt.DOT).ifEmpty { Fmt.DASH },
                                style = LpType.Small, color = c.soft, maxLines = 1,
                            )
                        }
                    }
                }
                LpCard {
                    CardLabel("Recent movements")
                    if (d.movements.isEmpty()) { Spacer(Modifier.height(10.dp)); Text(Fmt.DASH, style = LpType.Body, color = c.soft) }
                    d.movements.forEach { m ->
                        Box(Modifier.fillMaxWidth().padding(vertical = 6.dp).height(1.dp).background(c.line))
                        val wo = m.ref?.takeIf { it.type == "wo" }
                        Row(
                            Modifier.fillMaxWidth().let { r -> if (wo != null) r.clickable(role = Role.Button, onClickLabel = "Open work order") { actions.onOpenWo(wo.id) } else r }.padding(vertical = 6.dp),
                            verticalAlignment = Alignment.Top,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(RtKinds.words(m.kind), style = LpType.BodyStrong, color = c.fg)
                                Text(m.ref?.text() ?: Fmt.DASH, style = LpType.Small, color = c.soft, maxLines = 1)
                            }
                            Text(WoFmt.shortDayTime(m.at, zone), style = LpType.Small, color = c.soft, maxLines = 1, textAlign = TextAlign.End, modifier = Modifier.padding(start = 12.dp, top = 2.dp))
                        }
                    }
                }
            }
        }
    }
}

/** A count of labels in one now-group: icon and number, the group's name below. */
@Composable
private fun CountTile(group: NowGroup, n: Int, modifier: Modifier = Modifier) {
    val c = Lp.colors
    Column(modifier.background(group.tone.bg(), LpShapes.Row).padding(horizontal = 12.dp, vertical = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            LpIcon(group.icon, null, size = 20.dp, tint = group.tone.fg())
            Text(Fmt.count(n), style = LpType.ValueMedium, color = c.fg, maxLines = 1)
        }
        Text(group.label, style = LpType.Small, color = group.tone.fg(), maxLines = 2)
    }
}

/**
 * A label, stateless: item, status now, linked WO and PO, and the whole movement timeline (the API sends it oldest first; it is shown newest
 * first, like a work order's status history). A label with movements but no label row shows only the timeline.
 */
@Composable
fun RetraceLabelScreen(
    ui: RtDetailUi<RtLabelResponse>, label: String, store: Int, showBack: Boolean, actions: RetraceDetailActions, modifier: Modifier = Modifier, closeIcon: Boolean = false,
) {
    val c = Lp.colors
    val zone = LocalWoClock.current.zone
    Column(modifier.fillMaxSize()) {
        DetailBar(label, showBack, closeIcon, actions.onBack)
        val d = ui.data
        when {
            ui.view == LoadView.Loading && d == null -> Skeletons()
            d == null -> StateMessage(problemText(ui.problem), actionLabel = if (canRetry(ui.problem)) "Retry" else null, onAction = actions.onRetry)
            else -> Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = LpSpacing.Gutter).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
                val row = d.row
                if (row != null) LpCard {
                    Text(row.name ?: Fmt.DASH, style = LpType.Title.copy(fontWeight = FontWeight.Bold), color = c.fg)
                    Spacer(Modifier.height(10.dp))
                    NowChip(row.now, NowGroup.of(row.group))
                    Box(Modifier.fillMaxWidth().padding(vertical = 14.dp).height(1.dp).background(c.line))
                    Row {
                        LabelValue("Item", row.item ?: Fmt.DASH, Modifier.weight(1f))
                        LabelValue("Store", ui.storeName(store), Modifier.weight(1f))
                    }
                    Spacer(Modifier.height(12.dp))
                    Row {
                        val wo = row.wo
                        if (wo != null) Box(Modifier.weight(1f).clickable(role = Role.Button, onClickLabel = "Open work order") { actions.onOpenWo(wo) }) { LabelValue("Work order", wo) }
                        else LabelValue("Work order", Fmt.DASH, Modifier.weight(1f))
                        LabelValue("Purchase order", row.po ?: Fmt.DASH, Modifier.weight(1f))
                    }
                }
                LpCard {
                    CardLabel("Timeline", trailing = { Text(countText(d.movements.size, d.movementsTotal), style = LpType.Label, color = c.soft) })
                    Spacer(Modifier.height(8.dp))
                    if (d.movements.isEmpty()) Text(Fmt.DASH, style = LpType.Body, color = c.soft)
                    else TimelineRows(d.movements.asReversed().mapIndexed { i, m ->
                        val wo = m.ref?.takeIf { it.type == "wo" }
                        TimelineRow(RtKinds.words(m.kind), WoFmt.dayTime(m.at, zone), m.ref?.text(), current = i == 0, onClick = wo?.let { r -> { actions.onOpenWo(r.id) } })
                    })
                }
            }
        }
    }
}
