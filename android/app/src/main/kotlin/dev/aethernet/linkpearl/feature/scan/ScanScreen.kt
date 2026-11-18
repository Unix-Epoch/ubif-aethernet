package dev.aethernet.linkpearl.feature.scan

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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpIconButton
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType

/** Scan, stateless: the viewfinder ([camera]; null = none) and why the last code opened nothing. */
@Composable
fun ScanScreen(
    state: ScanUi,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    camera: (@Composable (onCode: (String) -> Unit) -> Unit)? = null,
    onCode: (String) -> Unit = {},
) {
    val c = Lp.colors
    Column(modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = LpSpacing.Gutter - 4.dp, end = LpSpacing.Gutter, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            LpIconButton(LpIcons.Back, "Back", onBack, Modifier.padding(end = 4.dp))
            Text("Scan", style = LpType.Screen, color = c.fg, maxLines = 1, modifier = Modifier.weight(1f).semantics { heading() })
        }
        Column(Modifier.fillMaxWidth().padding(horizontal = LpSpacing.Gutter), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
            Box(Modifier.fillMaxWidth().aspectRatio(1.3f).clip(LpShapes.Card).background(c.surf3)) { camera?.invoke(onCode) }
            state.message?.let {
                Box(Modifier.fillMaxWidth().clip(LpShapes.Card).background(c.warnBg).padding(horizontal = 14.dp, vertical = 12.dp)) {
                    Text(it, style = LpType.BodyStrong, color = c.warn)
                }
            }
        }
    }
}
