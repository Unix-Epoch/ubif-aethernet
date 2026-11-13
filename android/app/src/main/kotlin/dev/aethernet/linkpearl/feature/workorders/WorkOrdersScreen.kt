package dev.aethernet.linkpearl.feature.workorders

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpType

/** STUB: shows only its title. Replace with the real screen (the owner of this package edits this file). */
@Composable
fun WorkOrdersScreen(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 12.dp)) {
        Text("Work orders", style = LpType.Title, color = Lp.colors.fg, modifier = Modifier.semantics { heading() })
    }
}
