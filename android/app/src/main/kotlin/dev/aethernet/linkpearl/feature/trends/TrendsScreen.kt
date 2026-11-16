package dev.aethernet.linkpearl.feature.trends

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.aethernet.linkpearl.core.data.StoreScope
import dev.aethernet.linkpearl.core.design.CardLabel
import dev.aethernet.linkpearl.core.design.ChoiceRow
import dev.aethernet.linkpearl.core.design.Fmt
import dev.aethernet.linkpearl.core.design.LineChart
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpBottomSheet
import dev.aethernet.linkpearl.core.design.LpCard
import dev.aethernet.linkpearl.core.design.LpChip
import dev.aethernet.linkpearl.core.design.LpHeroCard
import dev.aethernet.linkpearl.core.design.LpIcon
import dev.aethernet.linkpearl.core.design.LpIconButton
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpPullToRefresh
import dev.aethernet.linkpearl.core.design.LpSegmented
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.design.NoticeLine
import dev.aethernet.linkpearl.core.design.RollingFigure
import dev.aethernet.linkpearl.core.design.StateMessage
import dev.aethernet.linkpearl.core.design.StoreAvatar
import dev.aethernet.linkpearl.core.design.TargetChip
import dev.aethernet.linkpearl.core.design.TargetState
import dev.aethernet.linkpearl.core.design.Tone
import dev.aethernet.linkpearl.core.design.TrendChart
import dev.aethernet.linkpearl.core.design.enter
import dev.aethernet.linkpearl.core.design.fg
import dev.aethernet.linkpearl.core.design.label
import dev.aethernet.linkpearl.core.design.splhState
import dev.aethernet.linkpearl.core.design.storeColor
import dev.aethernet.linkpearl.core.nav.HingeTwoPane
import dev.aethernet.linkpearl.core.nav.LocalAdaptive
import dev.aethernet.linkpearl.core.nav.LocalNavInset
import dev.aethernet.linkpearl.feature.home.SkeletonCard
import dev.aethernet.linkpearl.feature.home.StoreSwitcher
import dev.aethernet.linkpearl.feature.workorders.LoadView
import dev.aethernet.linkpearl.feature.workorders.Problem
import dev.aethernet.linkpearl.feature.workorders.canRetry
import dev.aethernet.linkpearl.feature.workorders.problemText

data class TrendsActions(
    val onBack: () -> Unit = {},
    val onPeriod: (TrendPeriod) -> Unit = {},
    val onScope: (StoreScope) -> Unit = {},
    val onPrevious: () -> Unit = {},
    val onNext: () -> Unit = {},
    val onRefresh: () -> Unit = {},
)

/**
 * Trends, stateless: back and title, Week / Month / Year, the store and the period pager, then Sales (hero, current against the previous
 * period), By store (All stores), Sales per labor hour, Cleaning rate and RFP total. From 600dp: two panes on the fold.
 */
@Composable
fun TrendsScreen(state: TrendsUi, actions: TrendsActions = TrendsActions(), modifier: Modifier = Modifier) {
    var menu by remember { mutableStateOf(false) }
    val wide = LocalAdaptive.current.isTwoPane
    val navInset = LocalNavInset.current
    val d = state.data?.takeIf { state.view == LoadView.Ok && !it.empty }
    val header = @Composable { Header(state, actions) { menu = true } }

    if (!wide) {
        Column(modifier.fillMaxSize()) {
            Column(Modifier.padding(horizontal = LpSpacing.Gutter).padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) { header() }
            LpPullToRefresh(refreshing = state.refreshing, onRefresh = actions.onRefresh, modifier = Modifier.fillMaxSize()) {
                Column(
                    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = LpSpacing.Gutter).padding(top = LpSpacing.M, bottom = 24.dp + navInset),
                    verticalArrangement = Arrangement.spacedBy(LpSpacing.M),
                ) {
                    Body(state, actions) { data ->
                        SalesCard(state, data, Modifier.enter(0))
                        if (!data.stores.isNullOrEmpty()) ByStoreCard(state, data, Modifier.enter(1))
                        SplhCard(state, data, Modifier.enter(2))
                        Tiles(data, Modifier.enter(3))
                    }
                }
            }
        }
    } else {
        HingeTwoPane(
            modifier = modifier.fillMaxSize(),
            first = {
                Column(
                    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = LpSpacing.Gutter).padding(top = 8.dp, bottom = 24.dp + navInset),
                    verticalArrangement = Arrangement.spacedBy(LpSpacing.M),
                ) {
                    header()
                    Body(state, actions) { data -> SalesCard(state, data, Modifier.enter(0)); Tiles(data, Modifier.enter(1)) }
                }
            },
            second = {
                Column(
                    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(end = LpSpacing.Gutter).padding(top = 8.dp, bottom = 24.dp + navInset),
                    verticalArrangement = Arrangement.spacedBy(LpSpacing.M),
                ) {
                    when (state.view) {
                        LoadView.Loading -> { SkeletonCard(chart = true); SkeletonCard() }
                        LoadView.Ok -> if (d != null) {
                            if (!d.stores.isNullOrEmpty()) ByStoreCard(state, d, Modifier.enter(1))
                            SplhCard(state, d, Modifier.enter(2))
                        }
                        LoadView.Error -> Unit
                    }
                }
            },
        )
    }

    if (menu) {
        LpBottomSheet(onDismiss = { menu = false }) {
            ChoiceRow("All stores", state.scope == StoreScope.All, { menu = false; actions.onScope(StoreScope.All) })
            state.stores.forEach { s -> ChoiceRow(s.label, state.scope == StoreScope.One(s.id), { menu = false; actions.onScope(StoreScope.One(s.id)) }) }
        }
    }
}

@Composable
private fun Header(state: TrendsUi, actions: TrendsActions, onStores: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        LpIconButton(LpIcons.Back, "Back", actions.onBack, Modifier.padding(end = 4.dp))
        Text("Trends", style = LpType.Screen, color = Lp.colors.fg, maxLines = 1, modifier = Modifier.weight(1f).semantics { heading() })
    }
    LpSegmented(TrendPeriod.entries.map { it.label }, state.period.ordinal, { actions.onPeriod(TrendPeriod.entries[it]) })
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f)) { StoreSwitcher(storeLabel(state), onStores, colorIndex = scopeIndex(state)) }
        Pager(state, actions)
    }
}

@Composable
private fun Pager(state: TrendsUi, actions: TrendsActions) {
    val unit = TrendsFmt.unitWord(state.period)
    Row(verticalAlignment = Alignment.CenterVertically) {
        LpIconButton(LpIcons.ChevronLeft, "Previous $unit", actions.onPrevious, enabled = state.canPrev)
        Text(state.periodLabel, style = LpType.BodyStrong.copy(fontSize = 17.sp), color = Lp.colors.fg, maxLines = 1, textAlign = TextAlign.Center, modifier = Modifier.widthIn(min = 64.dp))
        LpIconButton(LpIcons.ChevronRight, "Next $unit", actions.onNext, enabled = state.canNext)
    }
}

private fun storeLabel(state: TrendsUi): String = when (val s = state.scope) {
    StoreScope.All -> "All stores"
    is StoreScope.One -> state.stores.firstOrNull { it.id == s.id }?.label ?: Fmt.storeLabel(s.id, null)
}

private fun scopeIndex(state: TrendsUi): Int? = (state.scope as? StoreScope.One)?.let { one -> state.stores.indexOfFirst { it.id == one.id } }?.takeIf { it >= 0 }

/** Loading, error, empty and the notice line; [content] draws the cards when there is data. */
@Composable
private fun ColumnScope.Body(state: TrendsUi, actions: TrendsActions, content: @Composable ColumnScope.(TrendsData) -> Unit) {
    when (state.view) {
        LoadView.Loading -> { SkeletonCard(chart = true); SkeletonCard(); SkeletonCard() }
        LoadView.Error -> StateMessage(problemText(state.problem), actionLabel = if (canRetry(state.problem)) "Retry" else null, onAction = actions.onRefresh)
        LoadView.Ok -> {
            val d = state.data ?: return
            if (d.empty) { StateMessage("No stores"); return }
            state.problem?.let { p ->
                if (p == Problem.Offline) NoticeLine(Fmt.offline(Fmt.clock(d.asOf, d.tz ?: "America/New_York", d.today)), LpIcons.WifiOff, Modifier.fillMaxWidth())
                else NoticeLine(problemText(p), LpIcons.Warning, Modifier.fillMaxWidth(), warn = true, actionLabel = if (canRetry(p)) "Retry" else null, onAction = actions.onRefresh)
            }
            content(d)
        }
    }
}

// ---- cards ---------------------------------------------------------------------------------------------------------------------

/** Up = good with the trending-up icon, down = caution with trending-down; flat has no arrow. Words always. */
@Composable
private fun ChangeChip(change: Double?, text: String, modifier: Modifier = Modifier) {
    val dir = TrendsFmt.direction(change) ?: return
    when (dir) {
        Direction.Up -> LpChip(text, modifier.semantics { contentDescription = "Up $text" }, Tone.Good, LpIcons.TrendUp)
        Direction.Down -> LpChip(text, modifier.semantics { contentDescription = "Down $text" }, Tone.Warn, LpIcons.TrendDown)
        Direction.Flat -> LpChip(text, modifier, Tone.Neutral)
    }
}

/** A change written under a figure: arrow icon and amount, toned like [ChangeChip]. */
@Composable
private fun ChangeLine(delta: Double?, text: String, modifier: Modifier = Modifier) {
    val dir = TrendsFmt.direction(delta) ?: return
    val tone = when (dir) { Direction.Up -> Tone.Good; Direction.Down -> Tone.Warn; Direction.Flat -> Tone.Neutral }
    Row(modifier.semantics(mergeDescendants = true) { contentDescription = TrendsFmt.signWord(dir) + text }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        when (dir) { Direction.Up -> LpIcon(LpIcons.TrendUp, null, size = 18.dp, tint = tone.fg()); Direction.Down -> LpIcon(LpIcons.TrendDown, null, size = 18.dp, tint = tone.fg()); Direction.Flat -> Unit }
        Text(text, style = LpType.Chip, color = tone.fg(), maxLines = 1)
    }
}

@Composable
private fun CompareLine(label: String, value: String, modifier: Modifier = Modifier) {
    Text(
        buildAnnotatedString { append("$label "); withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(value) } },
        modifier, style = LpType.Row.copy(fontSize = 17.sp), color = Lp.colors.fg,
    )
}

@Composable
private fun SalesCard(state: TrendsUi, d: TrendsData, modifier: Modifier = Modifier) {
    val s = d.sales ?: TrendSales()
    val period = state.period
    val compare = TrendsFmt.compareLabel(period, d)
    LpHeroCard(modifier, shineKey = d.asOf) {
        CardLabel("Sales", trailing = { ChangeChip(s.changePct, TrendsFmt.pct(s.changePct)) })
        RollingFigure(Fmt.money(s.total), Modifier.padding(top = 4.dp), style = LpType.Hero)
        CompareLine(compare, Fmt.money(s.prevTotal), Modifier.padding(top = 6.dp))
        if (s.days.size >= 2) {
            val n = TrendsFmt.elapsed(period, s.days, d.today)
            val shown = s.days.take(n)
            val current = TrendsFmt.cumulative(shown.map { it.value })
            val previous = TrendsFmt.cumulative(s.prevDays.map { it.value }).take(s.days.size).takeIf { s.prevDays.any { it.value != null } }
            val desc = "Sales ${state.periodLabel}: ${Fmt.money(s.total)} so far; $compare ${Fmt.money(s.prevTotal)}"
            Spacer(Modifier.height(14.dp))
            TrendChart(
                current = current, previous = previous, axis = TrendsFmt.axis(period, s.days), contentDescription = desc,
                scrubLabel = { i -> TrendsFmt.bucketName(period, shown.getOrNull(i)?.day) + Fmt.DOT + Fmt.money(current.getOrNull(i)) },
                plotHeight = 120.dp, slots = s.days.size,
            )
        }
    }
}

@Composable
private fun SplhCard(state: TrendsUi, d: TrendsData, modifier: Modifier = Modifier) {
    val p = d.splh ?: TrendSplh()
    val target = (p.target ?: TrendTarget()).let { listOf(it.lo.toInt(), it.hi.toInt()) }
    val st = splhState(p.value, target)
    val n = TrendsFmt.elapsed(state.period, p.days, d.today)
    val values = p.days.take(n).map { it.value }
    LpCard(modifier) {
        CardLabel("Sales per labor hour", trailing = { if (p.hours != null) Text("${Fmt.hours(p.hours)} labor hours", style = LpType.Small, color = Lp.colors.soft, maxLines = 1) })
        Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(LpSpacing.M), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                RollingFigure(Fmt.money(p.value), style = LpType.Big)
                if (st != null) TargetChip(st, Modifier.padding(top = 8.dp))
            }
            if (values.count { it != null } >= 2) {
                LineChart(values, emptyList(), target, "Sales per labor hour by ${if (state.period == TrendPeriod.Year) "month" else "day"}, ${state.periodLabel}", Modifier.width(150.dp), plotHeight = 44.dp)
            }
        }
        CompareLine(TrendsFmt.compareLabel(state.period, d), Fmt.money(p.prev), Modifier.padding(top = 10.dp))
    }
}

@Composable
private fun Tiles(d: TrendsData, modifier: Modifier = Modifier) {
    val c = d.cleaning ?: TrendCleaning()
    val r = d.rfp ?: TrendRfp()
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
        Tile("Cleaning rate", Modifier.weight(1f)) {
            RollingFigure(TrendsFmt.percentValue(c.pct), style = LpType.BigCompact)
            Text(if (c.linked == null || c.orders == null) Fmt.DASH else "${Fmt.count(c.linked)} of ${Fmt.count(c.orders)}", style = LpType.Small, color = Lp.colors.soft, maxLines = 1)
            val delta = if (c.pct != null && c.prevPct != null) c.pct - c.prevPct else null
            ChangeLine(delta, TrendsFmt.points(delta), Modifier.padding(top = 6.dp))
        }
        Tile("RFP total", Modifier.weight(1f)) {
            RollingFigure(Fmt.money(r.total), style = LpType.BigCompact)
            Text(if (r.count == null) Fmt.DASH else "${Fmt.count(r.count)} Ready for pickup", style = LpType.Small, color = Lp.colors.soft, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val delta = if (r.total != null && r.prevTotal != null) r.total - r.prevTotal else null
            ChangeLine(delta, Fmt.money(delta?.let { kotlin.math.abs(it) }), Modifier.padding(top = 6.dp))
        }
    }
}

@Composable
private fun Tile(label: String, modifier: Modifier, content: @Composable ColumnScope.() -> Unit) {
    LpCard(modifier) {
        CardLabel(label)
        Spacer(Modifier.height(4.dp))
        content()
    }
}

@Composable
private fun ByStoreCard(state: TrendsUi, d: TrendsData, modifier: Modifier = Modifier) {
    val rows = d.stores.orEmpty()
    val target = (d.splh?.target ?: TrendTarget()).let { listOf(it.lo.toInt(), it.hi.toInt()) }
    LpCard(modifier, padding = 0.dp) {
        Row(Modifier.fillMaxWidth().padding(horizontal = LpSpacing.L, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("By store", style = LpType.Label, color = Lp.colors.soft, modifier = Modifier.weight(1f).semantics { heading() })
            Text("Sales", style = LpType.Label, color = Lp.colors.soft, textAlign = TextAlign.End, modifier = Modifier.width(SALES_W))
            Text("Per labor hr", style = LpType.Label, color = Lp.colors.soft, textAlign = TextAlign.End, maxLines = 1, modifier = Modifier.width(SPLH_W))
        }
        rows.forEach { s ->
            HorizontalDivider(color = Lp.colors.line)
            val index = state.stores.indexOfFirst { it.id == s.id }.takeIf { it >= 0 } ?: rows.indexOf(s)
            val st = splhState(s.splh, target)
            Row(
                Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = LpSpacing.L, vertical = 10.dp)
                    .semantics(mergeDescendants = true) {},
                verticalAlignment = Alignment.CenterVertically,
            ) {
                StoreAvatar(s.label, storeColor(index), size = 28.dp)
                Column(Modifier.weight(1f).padding(start = 10.dp, end = 6.dp)) {
                    Text(s.label, style = LpType.Switcher, color = Lp.colors.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    ChangeLine(s.changePct, TrendsFmt.pct(s.changePct))
                }
                Text(Fmt.money(s.sales), style = LpType.ValueMedium.copy(fontSize = 18.sp), color = Lp.colors.fg, textAlign = TextAlign.End, maxLines = 1, modifier = Modifier.width(SALES_W))
                Box(Modifier.width(SPLH_W), contentAlignment = Alignment.CenterEnd) { SplhValueChip(s.splh, st) }
            }
        }
    }
}

/** A store's sales per labor hour with Home's target rule as an icon (check, up, warning) and the words for TalkBack. */
@Composable
private fun SplhValueChip(value: Double?, st: TargetState?) {
    if (value == null || st == null) { Text(Fmt.DASH, style = LpType.BodyStrong, color = Lp.colors.soft); return }
    val text = Fmt.money(value)
    val m = Modifier.clearAndSetSemantics { contentDescription = "Sales per labor hour $text, ${st.label}" }
    when (st) {
        TargetState.On -> LpChip(text, m, Tone.Good, LpIcons.Check)
        TargetState.Over -> LpChip(text, m, Tone.Good, LpIcons.TrendUp)
        TargetState.Under -> LpChip(text, m, Tone.Warn, LpIcons.Warning)
    }
}

private val SALES_W = 92.dp
private val SPLH_W = 104.dp
