package dev.aethernet.linkpearl.feature.home

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.data.HomeData
import dev.aethernet.linkpearl.core.data.StoreScope
import dev.aethernet.linkpearl.core.design.AsOfLine
import dev.aethernet.linkpearl.core.design.ChoiceRow
import dev.aethernet.linkpearl.core.design.Fmt
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpBottomSheet
import dev.aethernet.linkpearl.core.design.LpIconButton
import dev.aethernet.linkpearl.core.design.LpIcon
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.design.NoticeLine
import dev.aethernet.linkpearl.core.design.Skeleton
import dev.aethernet.linkpearl.core.design.StateMessage
import dev.aethernet.linkpearl.core.nav.HingeTwoPane
import dev.aethernet.linkpearl.core.nav.LocalAdaptive

/**
 * Home, stateless: draws [state]. Phone width: one column (switcher, as-of line, cards). From 600dp: two panes on the fold
 * (sales, sales per labor hour and RFP total on the left; work orders, cleaning and by-age / by-store on the right).
 */
@Composable
fun HomeScreen(
    state: HomeUiState,
    onPickStore: (StoreScope) -> Unit,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var menu by remember { mutableStateOf(false) }
    val wide = LocalAdaptive.current.isTwoPane
    val switcher = @Composable { StoreSwitcher(storeLabel(state), onClick = { menu = true }) }
    val refresh = @Composable { RefreshButton(state.busy, onRefresh) }
    val status = @Composable { Status(state, onRefresh, Modifier) }
    val d = state.data.takeIf { state.view == HomeView.Ok && it?.empty != true }

    if (!wide) {
        Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = LpSpacing.Gutter).padding(top = 8.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(Modifier.weight(1f)) { switcher() }
                refresh()
            }
            when (state.view) {
                HomeView.Loading -> { Skeleton(Modifier.padding(top = 2.dp), width = 120.dp); SkeletonCard(); SkeletonCard(chart = true); SkeletonCard() }
                HomeView.Error -> StateMessage("Couldn't load", actionLabel = "Retry", onAction = onRefresh)
                HomeView.Ok -> {
                    status()
                    if (state.data?.empty == true) StateMessage("No stores")
                    else if (d != null) {
                        SalesCard(d, false); SplhCard(d, false); RfpCard(d); LanesCard(d, false); CleaningCard(d, false)
                    }
                }
            }
        }
    } else {
        HingeTwoPane(
            modifier = modifier.fillMaxSize(),
            first = {
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = LpSpacing.Gutter).padding(top = 8.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
                    Row(Modifier.heightIn(min = LpSpacing.Touch)) { switcher() }
                    when (state.view) {
                        HomeView.Loading -> { SkeletonCard(); SkeletonCard(chart = true); SkeletonCard() }
                        HomeView.Error -> StateMessage("Couldn't load", actionLabel = "Retry", onAction = onRefresh)
                        HomeView.Ok -> if (state.data?.empty == true) StateMessage("No stores") else if (d != null) { SalesCard(d, true); SplhCard(d, true); RfpCard(d) }
                    }
                }
            },
            second = {
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(end = LpSpacing.Gutter).padding(top = 8.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
                    Row(Modifier.fillMaxWidth().heightIn(min = LpSpacing.Touch), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(Modifier.weight(1f)) {
                            if (state.view == HomeView.Loading) Skeleton(width = 120.dp) else if (state.view == HomeView.Ok) status()
                        }
                        refresh()
                    }
                    when (state.view) {
                        HomeView.Loading -> { SkeletonCard(chart = true); SkeletonCard() }
                        HomeView.Ok -> if (d != null) { LanesCard(d, true); CleaningCard(d, true); ExtraCard(d) }
                        HomeView.Error -> Unit
                    }
                }
            },
        )
    }

    if (menu) {
        LpBottomSheet(onDismiss = { menu = false }) {
            ChoiceRow("All stores", state.scope == StoreScope.All, { menu = false; onPickStore(StoreScope.All) })
            state.stores.forEach { s ->
                ChoiceRow(s.label, state.scope == StoreScope.One(s.id), { menu = false; onPickStore(StoreScope.One(s.id)) })
            }
        }
    }
}

private fun storeLabel(state: HomeUiState): String = when (val s = state.scope) {
    StoreScope.All -> "All stores"
    is StoreScope.One -> state.stores.firstOrNull { it.id == s.id }?.label ?: Fmt.storeLabel(s.id, null)
}

/** The freshness line: As of / stale banner / offline / couldn't refresh. */
@Composable
private fun Status(state: HomeUiState, onRetry: () -> Unit, modifier: Modifier) {
    val d: HomeData = state.data ?: return
    if (d.empty) return
    val whenText = Fmt.clock(d.asOf, d.tz, d.today)
    val age = Fmt.minutesBetween(d.asOf, d.now)
    when {
        state.offline -> NoticeLine(Fmt.offline(whenText), LpIcons.WifiOff, modifier.fillMaxWidth())
        state.failed -> NoticeLine(Fmt.couldntRefresh(whenText), LpIcons.Clock, modifier.fillMaxWidth(), warn = true, actionLabel = "Retry", onAction = onRetry)
        d.stale && d.behind == null && age != null -> NoticeLine(Fmt.stale(Fmt.ago(age), whenText), LpIcons.Clock, modifier.fillMaxWidth(), warn = true)
        else -> AsOfLine(Fmt.asOf(whenText, d.behind?.let { it.name ?: "#${it.id}" }), modifier, warn = d.behind != null)
    }
}

/** The store switcher: a 48dp pill with the store icon, the name and a chevron. Opens the store sheet. */
@Composable
fun StoreSwitcher(label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = Lp.colors
    Row(
        modifier.heightIn(min = LpSpacing.Touch).widthIn(max = 360.dp).clip(LpShapes.Pill).background(c.surf3).border(1.5.dp, c.outline, LpShapes.Pill)
            .clickable(role = Role.DropdownList, onClick = onClick).semantics { contentDescription = "Store: $label" }
            .padding(start = 16.dp, end = 14.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        LpIcon(LpIcons.Store, null, size = 22.dp, tint = c.fg)
        Text(label, Modifier.weight(1f, fill = false), style = LpType.Switcher, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
        LpIcon(LpIcons.ChevronDown, null, size = 22.dp, tint = c.fg)
    }
}

@Composable
private fun RefreshButton(busy: Boolean, onRefresh: () -> Unit) {
    val rotation = if (busy) {
        val t = rememberInfiniteTransition(label = "refresh")
        val r by t.animateFloat(0f, 360f, infiniteRepeatable(tween(1000, easing = LinearEasing), RepeatMode.Restart), label = "spin")
        r
    } else 0f
    LpIconButton(LpIcons.Refresh, "Refresh", onRefresh, rotation = rotation)
}
