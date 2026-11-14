package dev.aethernet.linkpearl.feature.workorders

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.design.AsOfLine
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
import dev.aethernet.linkpearl.core.design.NoticeLine
import dev.aethernet.linkpearl.core.design.PillButton
import dev.aethernet.linkpearl.core.design.Skeleton
import dev.aethernet.linkpearl.core.design.StateMessage
import dev.aethernet.linkpearl.core.design.Tone
import dev.aethernet.linkpearl.core.lock.SecureWindow
import dev.aethernet.linkpearl.core.nav.LocalAdaptive
import java.time.Instant
import kotlin.time.Duration

data class WoDetailActions(
    val onBack: () -> Unit = {},
    val onRefresh: () -> Unit = {},
    val onUnlock: () -> Unit = {},
    val onLock: () -> Unit = {},
    val onCall: (String) -> Unit = {},
    val onText: (String) -> Unit = {},
    val onOpenPortal: (Long) -> Unit = {},
    /** A part's label on a closed work order: opens its Retrace page (store, label). */
    val onOpenLabel: (Int, String) -> Unit = { _, _ -> },
)

/**
 * One work order, stateless. Plain header, status history and cart always; the customer block is a locked placeholder until unlocked,
 * then name, phones (Call / Text), email, masked IMEI / serial with Reveal, and notes. Bottom: "Unlock" or "Locks in" + "Lock now".
 * Tabletop posture: content above the fold, big actions below. FLAG_SECURE is on while customer details are on screen.
 */
@Composable
fun WorkOrderDetailScreen(state: WoDetailUi, remaining: Duration?, showBack: Boolean, actions: WoDetailActions, modifier: Modifier = Modifier, closeIcon: Boolean = false) {
    val shown = (state.sealed as? SealedUi.Shown)?.data
    SecureWindow(enabled = shown != null)
    val nowMs = rememberNowMs(state.skewMs)
    val key = state.key
    val tabletop = LocalAdaptive.current.isTabletop

    Column(modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(start = if (showBack) 4.dp else LpSpacing.Gutter, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            if (showBack) LpIconButton(if (closeIcon) LpIcons.Close else LpIcons.Back, if (closeIcon) "Close" else "Back", actions.onBack)
            Text(key?.wo?.toString() ?: "", style = LpType.Title.copy(fontWeight = FontWeight.Bold), color = Lp.colors.fg, maxLines = 1,
                modifier = Modifier.weight(1f).padding(start = if (showBack) 8.dp else 0.dp).semantics { heading() })
            if (key != null) {
                if (!tabletop) LpIconButton(LpIcons.External, "Open in Portal", { actions.onOpenPortal(key.wo) })
                LpIconButton(LpIcons.Refresh, "Refresh", actions.onRefresh)
            }
        }
        val d = state.detail
        when {
            state.view == LoadView.Loading || d == null && state.view != LoadView.Error -> Column(Modifier.padding(horizontal = LpSpacing.Gutter), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
                SkeletonCard(); SkeletonCard(); SkeletonCard()
            }
            state.view == LoadView.Error || d == null -> StateMessage(problemText(state.problem), actionLabel = if (canRetry(state.problem)) "Retry" else null, onAction = actions.onRefresh)
            tabletop -> TabletopDetail(state, d, shown, nowMs, remaining, actions)
            else -> {
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = LpSpacing.Gutter).padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
                    Banner(state, actions)
                    HeaderCard(state, d, nowMs)
                    CustomerBlock(state, actions)
                    if (shown != null && shown.hasSnapshot) NotesCard(shown)
                    TimelineCard(d, nowMs)
                    SoldOrCart(d, actions)
                    if (!d.wo.open) ChangesCard(d.changes)
                }
                BottomBar(state, remaining, actions)
            }
        }
    }
}

/** An open work order's live cart; a closed one's parts sold (Portal empties the cart at the sale). */
@Composable
private fun SoldOrCart(d: WoDetailResponse, actions: WoDetailActions) {
    if (d.wo.open) CartCard(d)
    else PartsCard(d.parts?.rows.orEmpty(), onOpenLabel = { actions.onOpenLabel(d.wo.store, it) })
}

@Composable
private fun Banner(state: WoDetailUi, actions: WoDetailActions) {
    val p = state.problem ?: return
    if (p == Problem.Offline) NoticeLine(problemText(p), LpIcons.WifiOff, Modifier.fillMaxWidth())
    else NoticeLine(problemText(p), LpIcons.Warning, Modifier.fillMaxWidth(), warn = true, actionLabel = if (canRetry(p)) "Retry" else null, onAction = actions.onRefresh)
}

@Composable
private fun BottomBar(state: WoDetailUi, remaining: Duration?, actions: WoDetailActions) {
    val c = Lp.colors
    Column(Modifier.fillMaxWidth().background(c.page)) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(c.line))
        Row(Modifier.fillMaxWidth().padding(horizontal = LpSpacing.Gutter, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            if (!state.unlocked) {
                PillButton("Unlock to see customer and notes", actions.onUnlock, Modifier.fillMaxWidth().heightIn(min = 56.dp), icon = LpIcons.Lock)
            } else {
                LocksInChip(remaining)
                Spacer(Modifier.weight(1f))
                PillButton("Lock now", actions.onLock, Modifier.heightIn(min = 56.dp), icon = LpIcons.Lock)
            }
        }
    }
}

@Composable
private fun HeaderCard(state: WoDetailUi, d: WoDetailResponse, nowMs: Long, modifier: Modifier = Modifier) {
    val w = d.wo
    val c = Lp.colors
    LpCard(modifier) {
        Row(verticalAlignment = Alignment.Top) {
            Text(w.device ?: Fmt.DASH, style = LpType.Title.copy(fontWeight = FontWeight.Bold), color = c.fg, modifier = Modifier.weight(1f))
            if (w.open && w.statusSince != null) {
                LpChip(WoFmt.inStatusLong(w.statusSince, nowMs), tone = if (WoFmt.isLong(w.statusSince, nowMs)) Tone.Warn else Tone.Neutral, icon = LpIcons.Hourglass,
                    modifier = Modifier.semantics { contentDescription = "In status ${WoFmt.inStatusLong(w.statusSince, nowMs)}" })
            }
            if (!w.open) LpChip("Closed", tone = Tone.Neutral, icon = LpIcons.Check)
        }
        Spacer(Modifier.height(10.dp))
        StatusChip(w.status, w.lane)
        if (w.tags.isNotEmpty()) { Spacer(Modifier.height(10.dp)); TagRow(w.tags) }
        Box(Modifier.fillMaxWidth().padding(vertical = 14.dp).height(1.dp).background(c.line))
        Row {
            LabelValue("Program", w.program ?: Fmt.DASH, Modifier.weight(1f))
            LabelValue("Bin", w.bin ?: Fmt.DASH, Modifier.weight(1f))
        }
        Spacer(Modifier.height(12.dp))
        Row {
            LabelValue("Store", state.storeName(w.store), Modifier.weight(1f))
            if (!w.open) LabelValue("Sold value", WoFmt.money(w.lastCartValue ?: w.cartValue), Modifier.weight(1f))
            else LabelValue("Cart value", WoFmt.money(w.cartValue ?: d.cart?.value), Modifier.weight(1f))
        }
        val follow = w.followUp?.takeIf { it.valid }
        if (follow != null) {
            Spacer(Modifier.height(12.dp))
            Text("Follow-up", style = LpType.Small, color = c.soft)
            Spacer(Modifier.height(4.dp))
            FollowUpMarker(follow, todayLocal(nowMs), longName = true)
        }
        if (!w.open) {
            Spacer(Modifier.height(12.dp))
            Row {
                LabelValue("Closed", WoFmt.shortDayTime(w.closedAt, LocalWoClock.current.zone), Modifier.weight(1f))
                LabelValue("Outcome", w.outcome ?: w.closedReason ?: Fmt.DASH, Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun CustomerBlock(state: WoDetailUi, actions: WoDetailActions, modifier: Modifier = Modifier) {
    val c = Lp.colors
    when (val s = state.sealed) {
        SealedUi.Locked -> {
            Column(
                modifier.fillMaxWidth().drawBehind {
                    drawRoundRect(c.outline, style = Stroke(1.5.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(10f, 8f))), cornerRadius = CornerRadius(20.dp.toPx()))
                }.padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    IconBadge(LpIcons.Lock, size = 56.dp, tint = c.fg, background = c.surf3)
                    Text("Customer and notes locked", style = LpType.BodyStrong, color = c.fg)
                }
                Bar(190.dp); Bar(140.dp); Bar(280.dp)
            }
        }
        SealedUi.Loading -> LpCard(modifier) { Skeleton(width = 80.dp); Spacer(Modifier.height(12.dp)); Skeleton(width = 180.dp, height = 24.dp); Spacer(Modifier.height(12.dp)); Skeleton(width = 140.dp) }
        SealedUi.NoKey -> LpCard(modifier) { IconLine(LpIcons.Lock, "No key for this store") }
        SealedUi.Missing -> LpCard(modifier) { IconLine(LpIcons.Person, "No customer details yet") }
        SealedUi.Failed -> LpCard(modifier) {
            IconLine(LpIcons.Warning, "Couldn't open customer details")
            Spacer(Modifier.height(12.dp)); PillButton("Retry", actions.onRefresh, tonal = true)
        }
        is SealedUi.Shown -> CustomerCard(s.data, actions, modifier)
    }
}

@Composable
private fun IconLine(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        LpIcon(icon, null, tint = Lp.colors.fg)
        Text(text, style = LpType.BodyStrong, color = Lp.colors.fg)
    }
}

@Composable
fun CustomerCard(u: Unsealed, actions: WoDetailActions, modifier: Modifier = Modifier, contactButtons: Boolean = true) {
    val c = Lp.colors
    LpCard(modifier) {
        CardLabel("Customer")
        Spacer(Modifier.height(6.dp))
        Text(u.name ?: Fmt.DASH, style = LpType.Title.copy(fontWeight = FontWeight.Bold), color = c.fg)
        u.phones.forEach { p ->
            Spacer(Modifier.height(4.dp))
            Text(WoFmt.phone(p), style = LpType.Row.copy(fontSize = LpType.Title.fontSize), color = c.fg)
            if (contactButtons) {
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlineButton("Call", LpIcons.Phone, { actions.onCall(p) }, Modifier.weight(1f).semantics { contentDescription = "Call ${WoFmt.phone(p)}" })
                    OutlineButton("Text", LpIcons.Message, { actions.onText(p) }, Modifier.weight(1f).semantics { contentDescription = "Text ${WoFmt.phone(p)}" })
                }
            }
        }
        u.emails.forEach { e ->
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                LpIcon(LpIcons.Mail, "Email", size = 20.dp, tint = c.soft)
                Text(e, style = LpType.Body, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        val ids = listOfNotNull(u.imei?.let { "IMEI" to it }, u.serial?.takeIf { it != u.imei }?.let { "Serial" to it })
        if (ids.isNotEmpty()) Box(Modifier.fillMaxWidth().padding(vertical = 14.dp).height(1.dp).background(c.line))
        ids.forEachIndexed { i, (label, value) ->
            if (i > 0) Spacer(Modifier.height(10.dp))
            MaskedValue(label, value)
        }
    }
}

@Composable
private fun MaskedValue(label: String, value: String) {
    val c = Lp.colors
    var revealed by remember(value) { mutableStateOf(false) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(label, style = LpType.Small, color = c.soft)
            Text(if (revealed) value else WoFmt.mask(value), style = LpType.Row.copy(fontWeight = FontWeight.Bold), color = c.fg, maxLines = 1,
                modifier = Modifier.semantics { if (!revealed) contentDescription = "$label hidden, ends ${value.takeLast(4)}" })
        }
        PillButton(if (revealed) "Hide" else "Reveal", { revealed = !revealed }, tonal = true, icon = if (revealed) LpIcons.EyeOff else LpIcons.Eye,
            modifier = Modifier.semantics { stateDescription = if (revealed) "Shown" else "Hidden" })
    }
}

@Composable
fun NotesCard(u: Unsealed, modifier: Modifier = Modifier) {
    val c = Lp.colors
    val zone = LocalWoClock.current.zone
    val total = u.notesTotal
    val count = if (total != null && total > u.notes.size) "${u.notes.size} of $total" else u.notes.size.toString()
    LpCard(modifier) {
        CardLabel("Notes", trailing = { Text(count, style = LpType.Label, color = c.soft) })
        u.notes.forEach { n ->
            Box(Modifier.fillMaxWidth().padding(vertical = 12.dp).height(1.dp).background(c.line))
            val auto = n.kind == NoteKind.Automatic
            Text(n.text, style = LpType.Body, color = if (auto) c.soft else c.fg)
            Spacer(Modifier.height(4.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (auto) LpIcon(LpIcons.Auto, null, size = 16.dp, tint = c.soft)
                val meta = listOfNotNull(if (auto) "Auto" else null, n.author, WoFmt.shortDayTime(n.createdAt, zone)).joinToString(Fmt.DOT)
                Text(meta, style = LpType.Small, color = c.soft, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (u.fetchedAt != null) {
            Spacer(Modifier.height(12.dp))
            AsOfLine("As of " + WoFmt.shortDayTime(u.fetchedAt, zone))
        }
    }
}

@Composable
private fun TimelineCard(d: WoDetailResponse, nowMs: Long, modifier: Modifier = Modifier) {
    val c = Lp.colors
    val zone = LocalWoClock.current.zone
    class Item(val name: String, val at: String?, val dur: String?, val current: Boolean)
    val items = buildList {
        if (!d.wo.open && d.wo.closedAt != null) add(Item(d.wo.status ?: "Closed", d.wo.closedAt, null, false))
        d.timeline.forEach { t ->
            val secs = if (t.current && t.start != null) runCatching { (nowMs - Instant.parse(t.start).toEpochMilli()) / 1000 }.getOrNull() ?: t.seconds else t.seconds
            add(Item(t.status ?: Lane.of(t.lane)?.label ?: Fmt.DASH, t.start, WoFmt.seconds(secs).takeIf { secs != null }, t.current))
        }
        if (d.wo.createdAt != null) add(Item("Created", d.wo.createdAt, null, false))
    }
    if (items.isEmpty()) return
    LpCard(modifier) {
        CardLabel("Status history")
        Spacer(Modifier.height(8.dp))
        TimelineRows(items.map { TimelineRow(it.name, WoFmt.dayTime(it.at, zone), it.dur, it.current) })
    }
}

/** One stop on a timeline: what, when, and the trailing text (time in the status; a reference on a label's timeline). */
data class TimelineRow(val name: String, val whenText: String, val trailing: String?, val current: Boolean, val onClick: (() -> Unit)? = null)

/** The vertical timeline (dots on a line): the current stop has the filled accent dot. Shared by the work order and Retrace timelines. */
@Composable
fun TimelineRows(rows: List<TimelineRow>) {
    val c = Lp.colors
    Column {
        rows.forEachIndexed { i, it ->
            Row(
                Modifier.fillMaxWidth().height(IntrinsicSize.Min).let { m -> if (it.onClick != null) m.clickable(role = androidx.compose.ui.semantics.Role.Button, onClick = it.onClick) else m }
                    .semantics(mergeDescendants = true) { if (it.current) stateDescription = "Current" },
            ) {
                Box(Modifier.width(32.dp).heightIn(min = 60.dp), contentAlignment = Alignment.TopCenter) {
                    if (i < rows.lastIndex) Box(Modifier.padding(top = 14.dp).width(2.dp).fillMaxHeight().background(c.line))
                    if (it.current) Box(Modifier.padding(top = 4.dp).size(20.dp).clip(CircleShape).background(c.accSoft), contentAlignment = Alignment.Center) {
                        Box(Modifier.size(14.dp).clip(CircleShape).background(c.acc))
                    } else Box(Modifier.padding(top = 6.dp).size(16.dp).clip(CircleShape).background(c.surf).drawBehind { drawCircle(c.outline, style = Stroke(2.dp.toPx())) })
                }
                Column(Modifier.weight(1f).padding(start = 8.dp, bottom = 14.dp)) {
                    Text(it.name, style = if (it.current) LpType.Row.copy(fontWeight = FontWeight.Bold) else LpType.Row, color = c.fg)
                    Text(it.whenText, style = LpType.Small, color = c.soft)
                }
                if (it.trailing != null) Text(it.trailing, style = LpType.Body, color = c.soft, modifier = Modifier.padding(top = 2.dp))
            }
        }
    }
}

@Composable
private fun CartCard(d: WoDetailResponse, modifier: Modifier = Modifier) {
    val cart = d.cart ?: return
    if (cart.lines.isEmpty()) return
    val c = Lp.colors
    LpCard(modifier) {
        CardLabel("Cart", trailing = { Text(WoFmt.money(cart.total ?: cart.value), style = LpType.Label, color = c.fg) })
        cart.lines.forEach { l ->
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    val qty = l.quantity?.takeIf { it != 1.0 }?.let { " × ${if (it % 1.0 == 0.0) it.toInt() else it}" }.orEmpty()
                    Text((l.name ?: Fmt.DASH) + qty, style = LpType.Body, color = c.fg)
                    if (l.partStatus != null) Text(l.partStatus, style = LpType.Small, color = c.soft)
                }
                Text(WoFmt.money(l.totalPrice ?: l.price), style = LpType.Body, color = c.fg)
            }
        }
        if (cart.due != null) {
            Box(Modifier.fillMaxWidth().padding(vertical = 10.dp).height(1.dp).background(c.line))
            Row { Text("Due", style = LpType.BodyStrong, color = c.fg, modifier = Modifier.weight(1f)); Text(WoFmt.money(cart.due), style = LpType.BodyStrong, color = c.fg) }
        }
    }
}

@Composable
private fun SkeletonCard() {
    LpCard { Skeleton(width = 160.dp, height = 24.dp); Spacer(Modifier.height(12.dp)); Skeleton(width = 120.dp); Spacer(Modifier.height(12.dp)); Skeleton(width = 220.dp) }
}

// ---- tabletop: content above the fold, actions below ---------------------------------------------------------------------------

@Composable
private fun ColumnScope.TabletopDetail(state: WoDetailUi, d: WoDetailResponse, shown: Unsealed?, nowMs: Long, remaining: Duration?, actions: WoDetailActions) {
    val fold = LocalAdaptive.current.tabletopFold
    val density = LocalDensity.current
    var originY by remember { mutableFloatStateOf(0f) }
    BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().onGloballyPositioned { originY = it.positionInWindow().y }) {
        val total = maxHeight
        val topH = fold?.let { with(density) { (it.top - originY).toDp() } }?.takeIf { it > 120.dp && it < total - 120.dp } ?: (total / 2)
        val bottomStart = fold?.let { with(density) { (it.bottom - originY).toDp() } }?.takeIf { it >= topH && it < total } ?: topH
        Column(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxWidth().height(topH).padding(horizontal = LpSpacing.Gutter), horizontalArrangement = Arrangement.spacedBy(LpSpacing.L)) {
                Column(Modifier.weight(1f).fillMaxHeight().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
                    Banner(state, actions)
                    HeaderCard(state, d, nowMs)
                    TimelineCard(d, nowMs)
                }
                Column(Modifier.weight(1f).fillMaxHeight().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
                    if (shown != null) {
                        CustomerCard(shown, actions, contactButtons = false)
                        if (shown.hasSnapshot) NotesCard(shown)
                    } else CustomerBlock(state, actions)
                    SoldOrCart(d, actions)
                    if (!d.wo.open) ChangesCard(d.changes)
                }
            }
            Spacer(Modifier.height(bottomStart - topH + 16.dp))
            Column(Modifier.fillMaxWidth().padding(horizontal = LpSpacing.Gutter), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
                val key = state.key ?: return@Column
                if (state.unlocked) LocksInChip(remaining)
                val phone = shown?.phones?.firstOrNull()
                if (phone != null) Row(horizontalArrangement = Arrangement.spacedBy(LpSpacing.L)) {
                    OutlineButton("Call", LpIcons.Phone, { actions.onCall(phone) }, Modifier.weight(1f), tall = true)
                    OutlineButton("Text", LpIcons.Message, { actions.onText(phone) }, Modifier.weight(1f), tall = true)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(LpSpacing.L)) {
                    OutlineButton("Open in Portal", LpIcons.External, { actions.onOpenPortal(key.wo) }, Modifier.weight(1f), tall = true)
                    if (state.unlocked) OutlineButton("Lock now", LpIcons.Lock, actions.onLock, Modifier.weight(1f), tall = true, filled = true)
                    else OutlineButton("Unlock", LpIcons.Lock, actions.onUnlock, Modifier.weight(1f), tall = true, filled = true)
                }
            }
        }
    }
}

