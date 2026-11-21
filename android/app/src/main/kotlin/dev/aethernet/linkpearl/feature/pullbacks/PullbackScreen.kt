package dev.aethernet.linkpearl.feature.pullbacks

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.snapping.SnapPosition
import androidx.compose.foundation.gestures.snapping.rememberSnapFlingBehavior
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Icon
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.design.Fmt
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpCard
import dev.aethernet.linkpearl.core.design.LpChip
import dev.aethernet.linkpearl.core.design.LpDisplay
import dev.aethernet.linkpearl.core.design.LpHeroCard
import dev.aethernet.linkpearl.core.design.LpIconButton
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.design.PillButton
import dev.aethernet.linkpearl.core.design.ProgressBar
import dev.aethernet.linkpearl.core.design.StoreAvatar
import dev.aethernet.linkpearl.core.design.Tone
import dev.aethernet.linkpearl.core.design.glass
import dev.aethernet.linkpearl.core.design.rememberHaptics
import dev.aethernet.linkpearl.core.design.storeColor
import dev.aethernet.linkpearl.core.nav.LocalNavInset
import dev.aethernet.linkpearl.feature.workorders.OutlineButton

data class PullbackActions(
    val onBack: () -> Unit = {},
    val onOpenFile: () -> Unit = {},
    val onResume: () -> Unit = {},
    val onDiscard: () -> Unit = {},
    val onPickStore: (String) -> Unit = {},
    val onChangeFile: () -> Unit = {},
    val onStart: () -> Unit = {},
    val onScan: (String) -> Unit = {},
    val onAccept: () -> Unit = {},
    val onSkip: () -> Unit = {},
    val onUndo: () -> Unit = {},
    val onShare: () -> Unit = {},
    val onScanSkipped: () -> Unit = {},
    val onNewFile: () -> Unit = {},
)

/**
 * Pullbacks, stateless: open the PowerBI export, pick the store (the phone's own first), then scan item by item with the camera
 * ([camera] draws the viewfinder; null = no camera) or by typing, and share the results file at the end.
 */
@Composable
fun PullbackScreen(
    state: PbUi,
    actions: PullbackActions = PullbackActions(),
    modifier: Modifier = Modifier,
    camera: (@Composable (expected: String, onCode: (String) -> Unit) -> Unit)? = null,
) {
    val navInset = LocalNavInset.current
    Column(modifier.fillMaxSize()) {
        Header(state, actions.onBack)
        if (state is PbUi.Scanning) {
            Column(Modifier.weight(1f).fillMaxWidth().padding(horizontal = LpSpacing.Gutter), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
                ScanBody(state.s, actions, camera, state.pc)
            }
        } else Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = LpSpacing.Gutter).padding(bottom = LpSpacing.M),
            verticalArrangement = Arrangement.spacedBy(LpSpacing.M),
        ) {
            when (state) {
                is PbUi.Start -> StartBody(state, actions)
                is PbUi.Stores -> StoresBody(state, actions)
                is PbUi.Scanning -> {}
                is PbUi.Done -> DoneBody(state.s)
            }
        }
        val bottom = @Composable { content: @Composable () -> Unit ->
            Box(Modifier.fillMaxWidth().padding(horizontal = LpSpacing.Gutter).padding(top = 8.dp, bottom = 16.dp + navInset)) { content() }
        }
        when (state) {
            is PbUi.Start -> bottom { PillButton("Open PowerBI export", actions.onOpenFile, Modifier.fillMaxWidth(), icon = LpIcons.Download) }
            is PbUi.Stores -> bottom {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlineButton("Change file", null, actions.onChangeFile, Modifier.weight(1f))
                    PillButton("Start", actions.onStart, Modifier.weight(1f))
                }
            }
            is PbUi.Scanning -> bottom {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (state.s.msg == PbMsg.Mismatch) {
                        OutlineButton("Skip", null, actions.onSkip, Modifier.weight(1f))
                        PillButton("Accept anyway", actions.onAccept, Modifier.weight(1f), tonal = true)
                    } else {
                        OutlineButton("Undo", LpIcons.Undo, actions.onUndo, Modifier.weight(1f))
                        OutlineButton("Skip", null, actions.onSkip, Modifier.weight(1f))
                    }
                }
            }
            is PbUi.Done -> bottom {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    PillButton("Share results", actions.onShare, Modifier.fillMaxWidth(), icon = LpIcons.Share)
                    if (state.s.count(PbStatus.Skipped) > 0) OutlineButton("Scan skipped", null, actions.onScanSkipped, Modifier.fillMaxWidth())
                    OutlineButton("New file", null, actions.onNewFile, Modifier.fillMaxWidth())
                }
            }
        }
    }
}

@Composable
private fun Header(state: PbUi, onBack: () -> Unit) {
    val s = (state as? PbUi.Scanning)?.s ?: (state as? PbUi.Done)?.s
    val pc = (state as? PbUi.Scanning)?.pc ?: (state as? PbUi.Done)?.pc
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = LpSpacing.Gutter - 4.dp, end = LpSpacing.Gutter, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        LpIconButton(LpIcons.Back, "Back", onBack, Modifier.padding(end = 4.dp))
        Text("Pullbacks", style = LpType.Screen, color = Lp.colors.fg, maxLines = 1, modifier = Modifier.weight(1f).semantics { heading() })
        if (s != null) {
            val n = Pullbacks.storeNum(s.store)
            Row(Modifier.glass().padding(start = 6.dp, end = 12.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (s.link != null) PcBadge(pc == true)
                else if (n.isNotEmpty()) StoreNumber(n, storeColor(0))
                Text(if (s.complete) "Done" else "${(s.idx ?: 0) + 1} / ${s.total}", style = LpType.Chip, color = Lp.colors.fg, maxLines = 1)
            }
        }
    }
}

@Composable
private fun StoreNumber(n: String, color: androidx.compose.ui.graphics.Color) {
    Box(Modifier.clip(RoundedCornerShape(50)).background(color).padding(horizontal = 7.dp, vertical = 2.dp)) {
        Text(n, style = LpType.Chip.copy(fontFamily = LpDisplay, fontWeight = FontWeight.Bold), color = if (Lp.colors.isDark) Lp.colors.page else androidx.compose.ui.graphics.Color.White)
    }
}

/** "PC" on a run joined from Aethernet: accent while the browser is connected, soft while it is away. */
@Composable
internal fun PcBadge(online: Boolean) {
    val c = Lp.colors
    Box(Modifier.clip(RoundedCornerShape(50)).background(if (online) c.acc else c.surf3).padding(horizontal = 7.dp, vertical = 2.dp)
        .semantics { contentDescription = if (online) "PC connected" else "PC away" }) {
        Text("PC", style = LpType.Chip.copy(fontFamily = LpDisplay, fontWeight = FontWeight.Bold),
            color = if (!online) c.soft else if (c.isDark) c.page else androidx.compose.ui.graphics.Color.White)
    }
}

// ---------------------------------------------------------------- start
@Composable
private fun ColumnScope.StartBody(state: PbUi.Start, actions: PullbackActions) {
    val c = Lp.colors
    state.error?.let { Message(it, null, bad = true) }
    state.saved?.let { saved ->
        LpCard {
            Text(saved.file, style = LpType.BodyStrong, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(listOfNotNull(Pullbacks.storeNum(saved.store).takeIf { it.isNotEmpty() }?.let { "#$it" }, "${Fmt.count(saved.done)} of ${Fmt.count(saved.total)}").joinToString(" · "),
                style = LpType.Small, color = c.soft)
            Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlineButton("Discard", null, actions.onDiscard, Modifier.weight(1f))
                PillButton("Resume", actions.onResume, Modifier.weight(1f))
            }
        }
    }
}

// ---------------------------------------------------------------- store
@Composable
private fun ColumnScope.StoresBody(state: PbUi.Stores, actions: PullbackActions) {
    val c = Lp.colors
    val n = state.stores.firstOrNull { it.first == state.selected }?.second ?: 0
    LpHeroCard(shineKey = state.selected) {
        Text(state.file, style = LpType.Label, color = c.soft, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(Fmt.count(n), style = LpType.BigCompact, color = c.fg, modifier = Modifier.weight(1f))
            state.value?.let { LpChip(Fmt.money(it), tone = Tone.Accent) }
        }
    }
    state.stores.forEachIndexed { i, (store, count) ->
        val on = store == state.selected
        val name = store.replace(Regex("\\s*Store\\s*#\\s*\\d+\\s*$", RegexOption.IGNORE_CASE), "").ifBlank { store }
        Row(
            Modifier.fillMaxWidth().heightIn(min = 56.dp).clip(LpShapes.Card).background(if (on) c.accSoft else c.surf)
                .border(if (on) 2.dp else 1.dp, if (on) c.acc else c.line, LpShapes.Card)
                .clickable(role = Role.RadioButton) { actions.onPickStore(store) }.padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            val num = Pullbacks.storeNum(store)
            if (num.isNotEmpty()) StoreNumber(num, storeColor(i)) else StoreAvatar(name, storeColor(i))
            Text(name, style = LpType.Body, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text(Fmt.count(count), style = LpType.BodyStrong.copy(fontFamily = LpDisplay), color = c.soft)
        }
    }
}

// ---------------------------------------------------------------- scanning
/** After a good scan the camera rests this long while the row ticks and the list moves on. */
internal const val SCAN_REST_MS = 250L

/**
 * The run as a list in file order, snapping row by row: the current item is the large row at the top, the next ones below it, and
 * pulling down shows the ones already scanned. After each scan the list scrolls smoothly to the new current item.
 */
@Composable
private fun ColumnScope.ScanBody(s: PbSession, actions: PullbackActions, camera: (@Composable (String, (String) -> Unit) -> Unit)?, pc: Boolean? = null) {
    val c = Lp.colors
    val cur = s.current ?: return
    val i = s.idx ?: return
    val haptics = rememberHaptics()
    var typing by remember { mutableStateOf(camera == null) }
    var restUntil by remember { mutableStateOf(0L) }
    LaunchedEffect(s.history.size, s.msg) {
        when {
            s.msg == PbMsg.Mismatch -> haptics.reject()
            s.lastOk -> { haptics.confirm(); restUntil = System.currentTimeMillis() + SCAN_REST_MS }
        }
    }
    if (camera != null && !typing) {
        Box(Modifier.fillMaxWidth().height(180.dp).clip(LpShapes.Card)) {
            camera(cur.serial) { code -> if (System.currentTimeMillis() >= restUntil) actions.onScan(code) }
        }
    }
    if (typing || camera == null) ScanField(s.history.size to s.msg, actions.onScan)
    when (s.msg) {
        PbMsg.Mismatch -> Message("Mismatch", s.last, bad = true)
        PbMsg.Empty -> Message("Empty scan", null)
        PbMsg.Reverted -> Message("Reverted", null)
        null -> {}
    }
    if (s.link != null && pc == false && s.sending > 0) Message("PC offline · ${Fmt.count(s.sending)} waiting", null, bad = true)
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        ProgressBar((s.total - s.pending).toFloat() / s.total.coerceAtLeast(1), c.acc, Modifier.weight(1f))
        if (s.count(PbStatus.Skipped) > 0) LpChip("${Fmt.count(s.count(PbStatus.Skipped))} skipped", tone = Tone.Warn)
        if (camera != null) LpIconButton(if (typing) LpIcons.Camera else LpIcons.Keyboard, if (typing) "Camera" else "Type", { typing = !typing })
    }
    val list = rememberLazyListState(initialFirstVisibleItemIndex = i)
    LaunchedEffect(i) { list.animateScrollToItem(i) }
    LazyColumn(
        Modifier.weight(1f).fillMaxWidth(),
        state = list,
        flingBehavior = rememberSnapFlingBehavior(list, SnapPosition.Start),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        itemsIndexed(s.items, key = { k, _ -> k }) { k, item ->
            if (k == i) CurrentRow(item) else ItemRow(item, if (s.link != null) sync(item, pc == true) else null)
        }
    }
}

@Composable
private fun CurrentRow(it: PbItem) {
    val c = Lp.colors
    LpCard {
        Text(listOf(it.skuText, it.description).filter { t -> t.isNotBlank() }.joinToString(" · "), style = LpType.Label, color = c.soft, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(it.serial, style = LpType.Value, color = c.accText, modifier = Modifier.padding(top = 4.dp).semantics { contentDescription = "Expected serial ${it.serial}" })
    }
}

/** On a run joined from Aethernet: what the browser said about a scanned row (null while not scanned). */
private fun sync(it: PbItem, online: Boolean): Pair<String, Tone>? = when {
    it.status == PbStatus.Pending || it.status == PbStatus.Skipped -> null
    it.backendStatus == PbSession.SENDING -> (if (online) "Sending" else "Waiting") to Tone.Warn
    it.backendStatus == PbSession.QUEUED -> "Waiting" to Tone.Warn
    it.backendStatus == "success" -> "Marked" to Tone.Good
    it.backendStatus == "skipped-already-marked" -> "Already marked" to Tone.Accent
    it.backendStatus == "failed" -> "Failed" to Tone.Warn
    else -> "Sending" to Tone.Warn
}

/** A row that isn't the current one; a scanned row turns green with a tick that springs in ([sync]: the browser's word instead of the tick). */
@Composable
private fun ItemRow(it: PbItem, sync: Pair<String, Tone>? = null) {
    val c = Lp.colors
    val done = it.status == PbStatus.Matched || it.status == PbStatus.Overridden
    val bg by animateColorAsState(
        when { done -> c.goodBg; it.status == PbStatus.Skipped -> c.warnBg; else -> c.surf3 }, tween(SCAN_REST_MS.toInt()), label = "row",
    )
    val tick by animateFloatAsState(if (done) 1f else 0f, spring(dampingRatio = 0.5f, stiffness = Spring.StiffnessMedium), label = "tick")
    Row(
        Modifier.fillMaxWidth().clip(LpShapes.Card).background(bg).padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(it.description, style = LpType.Small, color = if (done) c.soft else c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(it.serial, style = LpType.Caption.copy(fontFamily = FontFamily.Monospace), color = c.soft, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (sync != null) LpChip(sync.first, tone = sync.second)
        else if (tick > 0.01f) Icon(LpIcons.Check, "Scanned", tint = c.good, modifier = Modifier.size(22.dp).graphicsLayer { scaleX = tick; scaleY = tick })
        else if (it.status == PbStatus.Skipped) Text("Skipped", style = LpType.Label, color = c.warn)
    }
}

/** A text field for typing or a keyboard-style barcode scanner (types, then Enter). Cleared after every entry. */
@Composable
internal fun ScanField(resetKey: Any, onScan: (String) -> Unit, placeholder: String = "Scan serial") {
    val c = Lp.colors
    var text by remember { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    LaunchedEffect(resetKey) { text = ""; runCatching { focus.requestFocus() } }
    BasicTextField(
        text, { text = it },
        singleLine = true,
        textStyle = LpType.BodyStrong.copy(color = c.fg, fontFamily = FontFamily.Monospace),
        cursorBrush = SolidColor(c.acc),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false, imeAction = ImeAction.Go),
        keyboardActions = KeyboardActions(onGo = { onScan(text); text = "" }, onDone = { onScan(text); text = "" }),
        modifier = Modifier.fillMaxWidth().focusRequester(focus).semantics { contentDescription = placeholder },
        decorationBox = { inner ->
            Box(Modifier.fillMaxWidth().heightIn(min = 56.dp).glass().padding(horizontal = 18.dp), contentAlignment = Alignment.CenterStart) {
                if (text.isEmpty()) Text(placeholder, style = LpType.Body, color = c.soft)
                inner()
            }
        },
    )
}

@Composable
internal fun Message(title: String, code: String?, bad: Boolean = false) {
    val c = Lp.colors
    Column(Modifier.fillMaxWidth().clip(LpShapes.Card).background(if (bad) c.warnBg else c.surf3).padding(horizontal = 14.dp, vertical = 12.dp)) {
        Text(title, style = LpType.BodyStrong, color = if (bad) c.warn else c.fg)
        if (code != null) Text(code, style = LpType.BodyStrong.copy(fontFamily = LpDisplay), color = c.fg)
    }
}

// ---------------------------------------------------------------- done
@Composable
private fun ColumnScope.DoneBody(s: PbSession) {
    val c = Lp.colors
    LpHeroCard(shineKey = s.done) {
        Text("Scan complete", style = LpType.Label, color = c.soft)
        Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.Bottom) {
            Text(Fmt.count(s.done), style = LpType.BigCompact, color = c.fg, modifier = Modifier.weight(1f))
            Text("of ${Fmt.count(s.total)}", style = LpType.Label, color = c.soft, modifier = Modifier.padding(bottom = 6.dp))
        }
        ProgressBar(s.done.toFloat() / s.total.coerceAtLeast(1), c.acc, Modifier.fillMaxWidth().padding(top = 10.dp))
        FlowRow(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            LpChip("${Fmt.count(s.count(PbStatus.Matched))} matched", tone = Tone.Good)
            if (s.count(PbStatus.Overridden) > 0) LpChip("${Fmt.count(s.count(PbStatus.Overridden))} overridden", tone = Tone.Warn)
            if (s.count(PbStatus.Skipped) > 0) LpChip("${Fmt.count(s.count(PbStatus.Skipped))} skipped", tone = Tone.Accent)
        }
    }
}
