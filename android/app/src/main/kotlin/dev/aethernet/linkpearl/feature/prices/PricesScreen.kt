package dev.aethernet.linkpearl.feature.prices

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.aethernet.linkpearl.core.design.AsOfLine
import dev.aethernet.linkpearl.core.design.ChoiceRow
import dev.aethernet.linkpearl.core.design.Fmt
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpBottomSheet
import dev.aethernet.linkpearl.core.design.LpCard
import dev.aethernet.linkpearl.core.design.LpIconButton
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpPullToRefresh
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.design.NoticeLine
import dev.aethernet.linkpearl.core.design.StateMessage
import dev.aethernet.linkpearl.core.design.enter
import dev.aethernet.linkpearl.core.nav.HingeTwoPane
import dev.aethernet.linkpearl.core.nav.LocalAdaptive
import dev.aethernet.linkpearl.core.nav.LocalNavInset
import dev.aethernet.linkpearl.feature.home.SkeletonCard
import dev.aethernet.linkpearl.feature.home.StoreSwitcher
import dev.aethernet.linkpearl.feature.workorders.FilterChip
import dev.aethernet.linkpearl.feature.workorders.LoadView
import dev.aethernet.linkpearl.feature.workorders.OutlineButton
import dev.aethernet.linkpearl.feature.workorders.Problem
import dev.aethernet.linkpearl.feature.workorders.SearchField
import dev.aethernet.linkpearl.feature.workorders.canRetry
import dev.aethernet.linkpearl.feature.workorders.problemText

data class PricesActions(
    val onBack: () -> Unit = {},
    val onQuery: (String) -> Unit = {},
    val onClear: () -> Unit = {},
    val onChoose: (PriceDevice) -> Unit = {},
    val onMatch: (Int) -> Unit = {},
    val onStore: (Int) -> Unit = {},
    val onRefresh: () -> Unit = {},
    val onShare: (String) -> Unit = {},
)

/**
 * Prices, stateless: back and title, the device search (filters the sheet's device list as you type), the matching devices as chips, the
 * store and "As of" (when the sheet was last synced), the chosen device's repairs and prices, Share. From 600dp: two panes on the fold.
 * [tz] and [today] date the "As of".
 */
@Composable
fun PricesScreen(state: PricesUi, tz: String, today: String?, actions: PricesActions = PricesActions(), modifier: Modifier = Modifier) {
    var menu by remember { mutableStateOf(false) }
    val wide = LocalAdaptive.current.isTwoPane
    val navInset = LocalNavInset.current
    val controls = @Composable { Controls(state, tz, today, actions) { menu = true } }

    if (!wide) {
        Column(modifier.fillMaxSize()) {
            Column(Modifier.padding(horizontal = LpSpacing.Gutter).padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
                Header(actions.onBack)
                controls()
            }
            LpPullToRefresh(refreshing = state.refreshing, onRefresh = actions.onRefresh, modifier = Modifier.fillMaxSize()) {
                Column(
                    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = LpSpacing.Gutter).padding(top = LpSpacing.M, bottom = 24.dp + navInset),
                    verticalArrangement = Arrangement.spacedBy(LpSpacing.M),
                ) { Results(state, actions) }
            }
        }
    } else {
        HingeTwoPane(
            modifier = modifier.fillMaxSize(),
            first = {
                Column(Modifier.fillMaxSize().padding(start = LpSpacing.Gutter).padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
                    Header(actions.onBack)
                    controls()
                }
            },
            second = {
                LpPullToRefresh(refreshing = state.refreshing, onRefresh = actions.onRefresh, modifier = Modifier.fillMaxSize()) {
                    Column(
                        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(end = LpSpacing.Gutter).padding(top = 72.dp, bottom = 24.dp + navInset),
                        verticalArrangement = Arrangement.spacedBy(LpSpacing.M),
                    ) { Results(state, actions) }
                }
            },
        )
    }

    if (menu) {
        LpBottomSheet(onDismiss = { menu = false }) {
            state.stores.forEach { s -> ChoiceRow(s.label, state.store == s.id, { menu = false; actions.onStore(s.id) }) }
        }
    }
}

@Composable
private fun Header(onBack: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
        LpIconButton(LpIcons.Back, "Back", onBack, Modifier.padding(end = 4.dp))
        Text("Prices", style = LpType.Screen, color = Lp.colors.fg, maxLines = 1, modifier = Modifier.weight(1f).semantics { heading() })
    }
}

@Composable
private fun Controls(state: PricesUi, tz: String, today: String?, actions: PricesActions, onStores: () -> Unit) {
    SearchField(state.query, unlocked = true, onQuery = actions.onQuery, onClear = actions.onClear, onUnlock = {}, placeholder = "Device")
    if (state.shown.isNotEmpty()) {
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            state.shown.forEach { d ->
                // A device that answers with two rows (a Fold's Inner and Outer) is shown as one chip per half.
                if (d == state.chosen && state.prices == LoadView.Ok && state.matches.size > 1)
                    state.matches.forEachIndexed { i, m -> FilterChip(m.chipLabel, null, i == state.matchIndex) { actions.onMatch(i) } }
                else FilterChip(d.name, null, d == state.chosen) { actions.onChoose(d) }
            }
        }
    }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.weight(1f)) {
            val index = state.stores.indexOfFirst { it.id == state.store }.takeIf { it >= 0 }
            StoreSwitcher(state.storeLabel(), onStores, colorIndex = index)
        }
        if (state.syncedAt != null) AsOfLine("As of " + Fmt.clock(state.syncedAt, tz, today))
    }
}

@Composable
private fun ColumnScope.Results(state: PricesUi, actions: PricesActions) {
    state.problem?.takeIf { state.list == LoadView.Ok && state.prices != LoadView.Error }?.let { p ->
        if (p == Problem.Offline) NoticeLine(problemText(p), LpIcons.WifiOff, Modifier.fillMaxWidth())
        else NoticeLine(problemText(p), LpIcons.Warning, Modifier.fillMaxWidth(), warn = true, actionLabel = if (canRetry(p)) "Retry" else null, onAction = actions.onRefresh)
    }
    when {
        state.list == LoadView.Loading -> { SkeletonCard(); SkeletonCard() }
        state.list == LoadView.Error -> StateMessage(problemText(state.problem), actionLabel = if (canRetry(state.problem)) "Retry" else null, onAction = actions.onRefresh)
        state.noSheet -> StateMessage("No price sheet")
        state.query.isBlank() -> Unit
        state.shown.isEmpty() -> StateMessage("No match")
        state.prices == LoadView.Loading -> SkeletonCard()
        state.prices == LoadView.Error -> StateMessage(problemText(state.problem), actionLabel = if (canRetry(state.problem)) "Retry" else null, onAction = actions.onRefresh)
        state.prices == LoadView.Ok -> {
            val m = state.match
            if (m == null) StateMessage("No match")
            else {
                RepairsCard(m)
                OutlineButton("Share", LpIcons.Outbox, { actions.onShare(PriceFmt.shareText(listOf(m))) }, Modifier.fillMaxWidth())
            }
        }
    }
}

@Composable
private fun RepairsCard(m: PriceMatch, modifier: Modifier = Modifier) {
    LpCard(modifier, padding = 0.dp) {
        if (m.repairs.isEmpty()) {
            Text(Fmt.DASH, Modifier.padding(LpSpacing.L), style = LpType.Row, color = Lp.colors.soft)
        }
        m.repairs.forEachIndexed { i, r ->
            if (i > 0) HorizontalDivider(color = Lp.colors.line)
            Row(
                Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = LpSpacing.L, vertical = 10.dp).semantics(mergeDescendants = true) {},
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(r.title, Modifier.weight(1f), style = LpType.Row, color = Lp.colors.fg)
                val priced = r.price != null
                Text(
                    r.shown, style = if (priced) LpType.ValueMedium.copy(fontSize = 21.sp) else LpType.Body.copy(fontWeight = FontWeight.Medium),
                    color = if (priced) Lp.colors.fg else Lp.colors.soft, textAlign = TextAlign.End, maxLines = 2,
                )
            }
        }
    }
}

/** Hands [text] to the Android share sheet. */
fun Context.sharePlainText(text: String) {
    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
    try { startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) {}
}

@Composable
internal fun rememberShare(): (String) -> Unit {
    val context = LocalContext.current
    return remember(context) { { text: String -> context.sharePlainText(text) } }
}
