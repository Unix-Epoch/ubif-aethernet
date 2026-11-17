package dev.aethernet.linkpearl.feature.alerts

import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.design.BigValue
import dev.aethernet.linkpearl.core.design.CardLabel
import dev.aethernet.linkpearl.core.design.Fmt
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpCard
import dev.aethernet.linkpearl.core.design.LpChip
import dev.aethernet.linkpearl.core.design.LpHeroCard
import dev.aethernet.linkpearl.core.design.LpIcon
import dev.aethernet.linkpearl.core.design.LpIconButton
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.design.RollingFigure
import dev.aethernet.linkpearl.core.design.Skeleton
import dev.aethernet.linkpearl.core.design.StateMessage
import dev.aethernet.linkpearl.core.design.TargetChip
import dev.aethernet.linkpearl.core.design.enter
import dev.aethernet.linkpearl.core.design.pressScale
import dev.aethernet.linkpearl.core.design.rememberHaptics
import dev.aethernet.linkpearl.core.design.splhState
import dev.aethernet.linkpearl.core.nav.HingeTwoPane
import dev.aethernet.linkpearl.core.nav.LocalAdaptive
import dev.aethernet.linkpearl.core.nav.LocalNavInset

sealed interface DigestUi {
    data object Loading : DigestUi
    /** Could not be read (offline or a server error), or it is not in this phone's feed ([gone]). */
    data class Missing(val offline: Boolean, val gone: Boolean = false) : DigestUi
    data class Ready(val alert: Alert) : DigestUi
}

/**
 * The Morning digest: yesterday's sales, sales per labor hour and labor hours (Home's rule and target band), the RFP total now, and the
 * work orders with a follow-up due today or stuck. Every work order row opens the work order. One column on phones, two on wide screens.
 */
@Composable
fun DigestScreen(
    ui: DigestUi,
    names: Map<Int, String>,
    onBack: (() -> Unit)?,
    onRetry: () -> Unit,
    onOpenWorkOrder: (store: Int, wo: Long) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = Lp.colors
    val d = (ui as? DigestUi.Ready)?.alert?.digest
    Column(modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = LpSpacing.Gutter, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            if (onBack != null) LpIconButton(LpIcons.Back, "Back", onBack) else Spacer(Modifier.padding(start = 12.dp))
            Text(AlertType.Digest.label, style = LpType.Title, color = c.fg, modifier = Modifier.weight(1f).padding(start = 4.dp).semantics { heading() }, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (d != null) Text(DigestText.date(d), style = LpType.Small, color = c.soft, maxLines = 1)
        }
        when (ui) {
            DigestUi.Loading -> Column(Modifier.padding(LpSpacing.Gutter), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Skeleton(Modifier.fillMaxWidth(), height = 150.dp, shape = LpShapes.Card)
                repeat(3) { Skeleton(Modifier.fillMaxWidth(), height = 96.dp, shape = LpShapes.Card) }
            }
            is DigestUi.Missing -> StateMessage(
                when { ui.gone -> "Not found"; ui.offline -> "Offline"; else -> "Couldn't load" },
                actionLabel = if (ui.gone) null else "Retry", onAction = if (ui.gone) null else onRetry,
            )
            is DigestUi.Ready -> DigestBody(ui.alert, ui.alert.digest ?: DigestFacts(), names, onOpenWorkOrder)
        }
    }
}

@Composable
private fun DigestBody(alert: Alert, d: DigestFacts, names: Map<Int, String>, onOpen: (Int, Long) -> Unit) {
    val bottom = 16.dp + LocalNavInset.current
    val top: @Composable (Modifier) -> Unit = { m ->
        Column(m.verticalScroll(rememberScrollState()).padding(horizontal = LpSpacing.Gutter).padding(top = 8.dp, bottom = bottom), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
            YesterdayCard(alert, d, Modifier.enter(0))
            RfpCard(d, Modifier.enter(1))
        }
    }
    val lists: @Composable (Modifier, Int) -> Unit = { m, from ->
        Column(m.verticalScroll(rememberScrollState()).padding(horizontal = LpSpacing.Gutter).padding(top = 8.dp, bottom = bottom), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
            WoListCard("Follow-ups due today", d.followupCount, d.followups, AlertType.Followup, d.manyStores, names, onOpen, Modifier.enter(from))
            WoListCard("Stuck", d.stuckCount, d.stuck, AlertType.Stuck, d.manyStores, names, onOpen, Modifier.enter(from + 1))
        }
    }
    if (LocalAdaptive.current.isCompact) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = LpSpacing.Gutter).padding(top = 8.dp, bottom = bottom), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
            YesterdayCard(alert, d, Modifier.enter(0))
            RfpCard(d, Modifier.enter(1))
            WoListCard("Follow-ups due today", d.followupCount, d.followups, AlertType.Followup, d.manyStores, names, onOpen, Modifier.enter(2))
            WoListCard("Stuck", d.stuckCount, d.stuck, AlertType.Stuck, d.manyStores, names, onOpen, Modifier.enter(3))
        }
    } else {
        HingeTwoPane(first = { top(Modifier.fillMaxSize()) }, second = { lists(Modifier.fillMaxSize(), 2) }, modifier = Modifier.fillMaxSize())
    }
}

/** The hero: yesterday's sales, sales per labor hour with its target state in words, labor hours. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun YesterdayCard(alert: Alert, d: DigestFacts, modifier: Modifier) {
    val c = Lp.colors
    val state = d.target?.let { splhState(d.splh, it) }
    LpHeroCard(modifier, shineKey = alert.id) {
        CardLabel("Yesterday")
        Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
            RollingFigure(Fmt.money(d.sales), Modifier.weight(1f), style = LpType.Hero)
            Column(horizontalAlignment = Alignment.End) {
                RollingFigure(Fmt.money(d.splh), style = LpType.Value)
                Text("per labor hour", style = LpType.Small, color = c.soft, maxLines = 1)
            }
        }
        FlowRow(
            Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp),
            itemVerticalAlignment = Alignment.CenterVertically,
        ) {
            if (state != null) TargetChip(state)
            LpChip("${Fmt.hours(d.hours)} labor hours")
        }
    }
}

/** RFP total now, the Ready for pickup count and the oldest device's days. */
@Composable
private fun RfpCard(d: DigestFacts, modifier: Modifier) {
    val c = Lp.colors
    LpCard(modifier) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
            Column(Modifier.weight(1f)) {
                CardLabel("RFP total")
                BigValue(Fmt.money(d.rfpTotal), compact = true)
            }
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    buildAnnotatedString {
                        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(Fmt.count(d.rfpCount)) }
                        append(" Ready for pickup")
                    },
                    style = LpType.Row, color = c.fg, maxLines = 1,
                )
                if ((d.rfpCount ?: 0) > 0) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    LpIcon(LpIcons.Clock, null, size = 20.dp, tint = c.soft)
                    Text(
                        buildAnnotatedString {
                            append("Oldest ")
                            withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(d.rfpOldestDays?.let { Fmt.days(it) } ?: Fmt.DASH) }
                        },
                        style = LpType.Row, color = c.fg, maxLines = 1,
                    )
                }
            }
        }
    }
}

/** "Follow-ups due today 2" or "Stuck 1" over its work orders; each row opens the work order. */
@Composable
private fun WoListCard(
    title: String, count: Int?, rows: List<DigestWo>, type: AlertType, manyStores: Boolean, names: Map<Int, String>,
    onOpen: (Int, Long) -> Unit, modifier: Modifier,
) {
    val c = Lp.colors
    GroupCard(modifier) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = LpSpacing.L, vertical = 8.dp).semantics(mergeDescendants = true) { heading() },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(title, style = LpType.Label, color = c.soft, modifier = Modifier.weight(1f))
            Text(Fmt.count(count), style = LpType.BodyStrong, color = c.fg)
        }
        rows.forEach { w ->
            Hairline()
            DigestWoRow(w, type, manyStores, names) { onOpen(w.store, w.wo) }
        }
    }
}

/** "Diagnostics · 5 days" (and "· Lynnhaven #326" when the digest spans several stores); a dash when nothing is known. */
fun digestWoLine(w: DigestWo, manyStores: Boolean, names: Map<Int, String>): String =
    listOfNotNull(w.status, w.days?.let { Fmt.days(it) }, if (manyStores) Fmt.storeLabel(w.store, names[w.store]) else null)
        .joinToString(Fmt.DOT).ifEmpty { Fmt.DASH }

@Composable
private fun DigestWoRow(w: DigestWo, type: AlertType, manyStores: Boolean, names: Map<Int, String>, onClick: () -> Unit) {
    val c = Lp.colors
    val haptics = rememberHaptics()
    val interaction = remember { MutableInteractionSource() }
    val line = digestWoLine(w, manyStores, names)
    Row(
        Modifier.fillMaxWidth().heightIn(min = 72.dp).pressScale(interaction)
            .clickable(interaction, LocalIndication.current, role = Role.Button) { haptics.tick(); onClick() }
            .semantics(mergeDescendants = true) { contentDescription = "Work order ${w.wo}. $line" }
            .padding(horizontal = LpSpacing.L, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        TypeBadge(type, size = 44.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(w.wo.toString(), style = LpType.Number, color = c.fg, maxLines = 1)
            Text(line, style = LpType.Small, color = c.soft, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        LpIcon(LpIcons.ChevronRight, null, tint = c.soft)
    }
}
