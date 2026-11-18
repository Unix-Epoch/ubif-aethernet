package dev.aethernet.linkpearl.feature.buybacks

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.design.Fmt
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpCard
import dev.aethernet.linkpearl.core.design.LpChip
import dev.aethernet.linkpearl.core.design.LpIconButton
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.design.PillButton
import dev.aethernet.linkpearl.core.design.ProgressBar
import dev.aethernet.linkpearl.core.design.StateMessage
import dev.aethernet.linkpearl.core.design.Tone
import dev.aethernet.linkpearl.core.design.glass
import dev.aethernet.linkpearl.core.design.rememberHaptics
import dev.aethernet.linkpearl.core.nav.LocalNavInset
import dev.aethernet.linkpearl.feature.pullbacks.Message
import dev.aethernet.linkpearl.feature.pullbacks.PcBadge
import dev.aethernet.linkpearl.feature.pullbacks.ScanField

data class BuybackActions(val onBack: () -> Unit = {}, val onCode: (String, Boolean) -> Unit = { _, _ -> })

/**
 * Buybacks, stateless: the PC's buyback run, scanned here. [camera] draws the viewfinder (null = typing only); it reads every serial
 * code, and anything but a B- label is ignored. Each scan shows the browser's answer: Sending, Added, or Failed with Portal's message.
 */
@Composable
fun BuybackScreen(
    state: BbUi,
    actions: BuybackActions = BuybackActions(),
    modifier: Modifier = Modifier,
    camera: (@Composable (onCode: (String) -> Unit) -> Unit)? = null,
) {
    val c = Lp.colors
    val navInset = LocalNavInset.current
    var typing by remember { mutableStateOf(camera == null) }
    Column(modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = LpSpacing.Gutter - 4.dp, end = LpSpacing.Gutter, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            LpIconButton(LpIcons.Back, "Back", actions.onBack, Modifier.padding(end = 4.dp))
            Text("Buybacks", style = LpType.Screen, color = c.fg, maxLines = 1, modifier = Modifier.weight(1f).semantics { heading() })
            if (state is BbUi.Scanning) Row(
                Modifier.glass().padding(start = 6.dp, end = 12.dp, top = 6.dp, bottom = 6.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                PcBadge(state.pc)
                Text("${Fmt.count(state.run.added)} / ${Fmt.count(state.run.total)}", style = LpType.Chip, color = c.fg, maxLines = 1)
            }
        }
        Column(Modifier.weight(1f).fillMaxWidth().padding(horizontal = LpSpacing.Gutter), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
            when (state) {
                is BbUi.None -> StateMessage(if (state.stopped) "Stopped on the PC" else "No buybacks from the PC", Modifier.fillMaxWidth().padding(top = 40.dp))
                is BbUi.Scanning -> ScanBody(state, actions, camera, typing)
            }
        }
        if (state is BbUi.Scanning && camera != null) Box(Modifier.fillMaxWidth().padding(horizontal = LpSpacing.Gutter).padding(top = 8.dp, bottom = 16.dp + navInset)) {
            PillButton(if (typing) "Camera" else "Type", { typing = !typing }, Modifier.fillMaxWidth(), tonal = true)
        }
    }
}

@Composable
private fun ColumnScope.ScanBody(s: BbUi.Scanning, actions: BuybackActions, camera: (@Composable ((String) -> Unit) -> Unit)?, typing: Boolean) {
    val c = Lp.colors
    val haptics = rememberHaptics()
    val last = s.last
    LaunchedEffect(last?.label, last?.state) {
        when (last?.state) { BbScanState.Added -> haptics.confirm(); BbScanState.Failed -> haptics.reject(); else -> {} }
    }
    if (camera != null && !typing) Box(Modifier.fillMaxWidth().height(180.dp).clip(LpShapes.Card)) { camera { actions.onCode(it, false) } }
    if (typing || camera == null) ScanField(s.scans.size to s.notLabel, { actions.onCode(it, true) }, placeholder = "Scan buyback label")
    when {
        s.notLabel != null -> Message("Not a buyback label", s.notLabel, bad = true)
        last?.state == BbScanState.Failed -> Message(last.message ?: "Couldn't add", last.label, bad = true)
        last != null -> LpCard {
            if (last.destination.isNotBlank()) Text(last.destination, style = LpType.Label, color = c.soft, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(last.label, style = LpType.Value, color = c.accText, modifier = Modifier.padding(top = 4.dp))
            ProgressBar(s.run.added.toFloat() / s.run.total.coerceAtLeast(1), c.acc, Modifier.fillMaxWidth().padding(top = 10.dp))
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                LpChip("${Fmt.count(s.run.added)} added", tone = Tone.Good)
                LpChip("${Fmt.count((s.run.total - s.run.added).coerceAtLeast(0))} left", tone = Tone.Accent)
            }
        }
        else -> {}
    }
    if (!s.pc && s.sending > 0) Message("PC offline · ${Fmt.count(s.sending)} waiting", null, bad = true)
    LazyColumn(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(s.scans, key = { "s" + it.label }) { LabelRow(it.label, it.destination, when (it.state) {
            BbScanState.Sending -> (if (s.pc) "Sending" else "Waiting") to Tone.Warn
            BbScanState.Added -> "Added" to Tone.Good
            BbScanState.Failed -> "Failed" to Tone.Warn
        }) }
        items(s.toScan, key = { "t" + it.label }) { LabelRow(it.label, it.destination, "To scan" to Tone.Neutral) }
    }
}

@Composable
private fun LabelRow(label: String, destination: String, chip: Pair<String, Tone>) {
    val c = Lp.colors
    Row(
        Modifier.fillMaxWidth().clip(LpShapes.Card).background(c.surf3).padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text("…" + label.takeLast(6), style = LpType.BodyStrong.copy(fontFamily = FontFamily.Monospace), color = c.fg, maxLines = 1)
            if (destination.isNotBlank()) Text(Buybacks.shortDestination(destination), style = LpType.Caption, color = c.soft, maxLines = 1)
        }
        LpChip(chip.first, tone = chip.second)
    }
}
