package dev.aethernet.linkpearl.feature.update

import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpIcon
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.design.Pearl
import dev.aethernet.linkpearl.core.design.PillButton
import dev.aethernet.linkpearl.core.design.ProgressBar
import dev.aethernet.linkpearl.core.di.LocalAppContainer

/**
 * Wraps the signed-in app: when this build is older than the server's minimum, only [UpdateNeededScreen] is shown. Also opens Android's
 * "Install unknown apps" page when the controller asks, and checks for an update on resume (at most every few hours).
 */
@Composable
fun UpdateGate(content: @Composable () -> Unit) {
    val container = LocalAppContainer.current
    val controller = remember { container.get<UpdateController>() }
    val state by controller.state.collectAsStateWithLifecycle()
    UpdateEffects(controller)
    if (state.required) UpdateNeededScreen(state, onUpdate = controller::update) else content()
}

@Composable
private fun UpdateEffects(controller: UpdateController) {
    val context = LocalContext.current
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { controller.onResume() }
    LaunchedEffect(controller) {
        controller.permissionRequests.collect {
            runCatching {
                context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, ("package:" + context.packageName).toUri()))
            }
        }
    }
}

/** The blocking screen: pearl, "Update needed", "1.1.1 → 1.2.0", Update, and the download's progress. */
@Composable
fun UpdateNeededScreen(state: UpdateState, modifier: Modifier = Modifier, onUpdate: () -> Unit = {}) {
    val c = Lp.colors
    Box(modifier.fillMaxSize().background(c.page).safeDrawingPadding().verticalScroll(rememberScrollState()), contentAlignment = Alignment.Center) {
        Column(
            Modifier.widthIn(max = 420.dp).fillMaxWidth().padding(horizontal = 32.dp, vertical = 48.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Pearl(Modifier.size(120.dp))
            Text("Update needed", style = LpType.Title, color = c.fg, modifier = Modifier.padding(top = 20.dp).semantics { heading() })
            VersionArrow(state.current.name, state.targetName, Modifier.padding(top = 10.dp))
            PillButton("Update", onUpdate, Modifier.fillMaxWidth().padding(top = 36.dp), icon = LpIcons.Download)
            UpdateProgress(state.phase, Modifier.padding(top = 20.dp))
        }
    }
}

@Composable
private fun VersionArrow(from: String, to: String?, modifier: Modifier = Modifier) {
    val c = Lp.colors
    Row(
        modifier.semantics(mergeDescendants = true) { contentDescription = "Version $from to ${to ?: "newer"}" },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(from, style = LpType.Row, color = c.soft)
        LpIcon(LpIcons.ArrowRight, null, size = 20.dp, tint = c.soft)
        Text(to ?: "—", style = LpType.Row.copy(fontWeight = FontWeight.Bold), color = c.fg)
    }
}

/** The bar with "2.5 of 4.1 MB" and "62%" while downloading; the error line after a failure; nothing otherwise. */
@Composable
fun UpdateProgress(phase: UpdatePhase, modifier: Modifier = Modifier) {
    val c = Lp.colors
    when (phase) {
        is UpdatePhase.Downloading -> Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(LpSpacing.S)) {
            val pct = UpdateFmt.percent(phase.fraction)
            ProgressBar(phase.fraction, c.acc, contentDescription = "Downloading, $pct", growKey = Unit)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(UpdateFmt.progress(phase.bytes, phase.total), style = LpType.Small, color = c.soft)
                Text(pct, style = LpType.Small, color = c.soft)
            }
        }
        UpdatePhase.Verifying, UpdatePhase.Installing -> Column(modifier.fillMaxWidth()) {
            ProgressBar(1f, c.acc, contentDescription = "Installing", growKey = Unit)
        }
        is UpdatePhase.Failed -> Row(
            modifier.heightIn(min = 24.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            LpIcon(LpIcons.Warning, null, size = 20.dp, tint = c.warn)
            Text(phase.message, style = LpType.BodyStrong, color = c.warn)
        }
        UpdatePhase.Idle, UpdatePhase.NeedsPermission -> Unit
    }
}
