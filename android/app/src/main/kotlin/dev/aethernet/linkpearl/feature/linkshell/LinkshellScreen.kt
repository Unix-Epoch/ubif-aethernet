package dev.aethernet.linkpearl.feature.linkshell

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.aethernet.linkpearl.core.design.Fmt
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpCard
import dev.aethernet.linkpearl.core.design.LpDisplay
import dev.aethernet.linkpearl.core.design.LpHeroCard
import dev.aethernet.linkpearl.core.design.LpIconButton
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.feature.workorders.OutlineButton
import dev.aethernet.linkpearl.core.design.PillButton
import dev.aethernet.linkpearl.core.design.ProgressBar
import dev.aethernet.linkpearl.core.nav.LocalNavInset
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

data class LinkshellActions(
    val onBack: () -> Unit = {},
    val onCode: (String) -> Unit = {},
    val onCancel: () -> Unit = {},
    val onUnlink: () -> Unit = {},
    val onJoin: () -> Unit = {},
)

/**
 * Linkshell, stateless: scan Aethernet's code ([camera] draws the viewfinder; null = none), compare the check code with the browser's,
 * then the linked browser, its state, and a Pullbacks run it sent. [storeName] turns a store id into its name.
 */
@Composable
fun LinkshellScreen(
    state: LsUi,
    actions: LinkshellActions = LinkshellActions(),
    modifier: Modifier = Modifier,
    storeName: (Int) -> String? = { null },
    camera: (@Composable (onCode: (String) -> Unit) -> Unit)? = null,
) {
    val c = Lp.colors
    val navInset = LocalNavInset.current
    Column(modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = LpSpacing.Gutter - 4.dp, end = LpSpacing.Gutter, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            LpIconButton(LpIcons.Back, "Back", actions.onBack, Modifier.padding(end = 4.dp))
            Text("Linkshell", style = LpType.Screen, color = c.fg, maxLines = 1, modifier = Modifier.weight(1f).semantics { heading() })
        }
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = LpSpacing.Gutter).padding(bottom = LpSpacing.M),
            verticalArrangement = Arrangement.spacedBy(LpSpacing.M),
        ) {
            when (state) {
                is LsUi.Scan -> {
                    if (camera != null) Box(Modifier.fillMaxWidth().aspectRatio(1.3f).clip(LpShapes.Card)) { camera(actions.onCode) }
                    state.error?.let { Line(it) }
                }
                is LsUi.Check -> LpCard {
                    Pc(storeName(state.store) ?: "#${state.store}", state.pcName)
                    Text(
                        state.code, style = LpType.BigCompact.copy(fontFamily = LpDisplay, fontWeight = FontWeight.Bold, letterSpacing = 3.sp), color = c.accText,
                        textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 4.dp),
                    )
                }
                is LsUi.Linked -> {
                    LpCard {
                        val status = if (state.peer) "Connected" else seen(state.seen)?.let { "Seen $it" } ?: "Away"
                        Pc(storeName(state.store) ?: "#${state.store}", status, dot = state.peer)
                    }
                    state.offer?.let { run ->
                        LpHeroCard(shineKey = run.run) {
                            Text("Pullbacks", style = LpType.Label, color = c.soft)
                            Text("${Fmt.count(run.done)} / ${Fmt.count(run.total)}", style = LpType.BigCompact, color = c.fg, modifier = Modifier.padding(top = 6.dp))
                            ProgressBar(run.done.toFloat() / run.total.coerceAtLeast(1), c.acc, Modifier.fillMaxWidth().padding(top = 10.dp))
                        }
                    }
                    state.error?.let { Line(it) }
                }
            }
        }
        Box(Modifier.fillMaxWidth().padding(horizontal = LpSpacing.Gutter).padding(top = 8.dp, bottom = 16.dp + navInset)) {
            when (state) {
                is LsUi.Scan -> OutlineButton("Cancel", null, actions.onBack, Modifier.fillMaxWidth())
                is LsUi.Check -> OutlineButton("Cancel", null, actions.onCancel, Modifier.fillMaxWidth())
                is LsUi.Linked -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlineButton("Unlink", null, actions.onUnlink, Modifier.weight(1f))
                    if (state.offer != null) PillButton("Join", actions.onJoin, Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun Pc(title: String, sub: String, dot: Boolean = false) {
    val c = Lp.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(Modifier.size(40.dp).clip(RoundedCornerShape(12.dp)).background(c.accSoft), contentAlignment = Alignment.Center) {
            Text("PC", style = LpType.Chip.copy(fontFamily = LpDisplay, fontWeight = FontWeight.Bold), color = c.accText)
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = LpType.BodyStrong, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (dot) Box(Modifier.size(7.dp).clip(CircleShape).background(c.good))
                Text(sub, style = LpType.Small, color = c.soft, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun Line(text: String) {
    val c = Lp.colors
    Box(Modifier.fillMaxWidth().clip(LpShapes.Card).background(c.warnBg).padding(horizontal = 14.dp, vertical = 12.dp)) {
        Text(text, style = LpType.BodyStrong, color = c.warn)
    }
}

private val TIME = DateTimeFormatter.ofPattern("h:mm a")
private fun seen(iso: String?): String? = iso?.let { runCatching { OffsetDateTime.parse(it).atZoneSameInstant(ZoneId.systemDefault()).format(TIME) }.getOrNull() }
