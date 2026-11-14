package dev.aethernet.linkpearl.core.design

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/**
 * A two-or-more way switch (Open / Closed, Items / Purchase orders): equal-width segments drawn like the filter chips (selected = soft
 * fill, check and bold words; the others outlined), so the selection never rests on colour alone.
 */
@Composable
fun LpSegmented(options: List<String>, selectedIndex: Int, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    val c = Lp.colors
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEachIndexed { i, label ->
            val on = i == selectedIndex
            Row(
                Modifier.weight(1f).heightIn(min = LpSpacing.Touch).clip(LpShapes.Row).let { if (on) it.background(c.accSoft) else it.border(1.5.dp, c.outline, LpShapes.Row) }
                    .clickable(role = Role.Tab) { onSelect(i) }.semantics { selected = on }.padding(horizontal = 14.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
            ) {
                if (on) LpIcon(LpIcons.Check, null, size = 18.dp, tint = c.onAccSoft)
                Text(label, style = LpType.Row.copy(fontWeight = if (on) FontWeight.Bold else FontWeight.Normal), color = if (on) c.onAccSoft else c.fg, maxLines = 1)
            }
        }
    }
}
