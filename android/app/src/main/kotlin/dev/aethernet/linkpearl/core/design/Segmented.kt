package dev.aethernet.linkpearl.core.design

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * A two-or-more way switch (Open / Closed, Items / Purchase orders, Week / Month / Year): a glass track with a solid thumb that
 * slides to the chosen segment. The chosen words are bold on the thumb, so the selection never rests on colour alone.
 */
@Composable
fun LpSegmented(options: List<String>, selectedIndex: Int, onSelect: (Int) -> Unit, modifier: Modifier = Modifier) {
    val c = Lp.colors
    val haptics = rememberHaptics()
    val motion = motionOn()
    val pos by animateFloatAsState(selectedIndex.toFloat(), if (motion) LpMotion.settle() else androidx.compose.animation.core.snap(), label = "thumb")
    val thumb = if (c.isDark) c.fg else c.acc
    val onThumb = if (c.isDark) c.page else c.onAcc
    BoxWithConstraints(modifier.fillMaxWidth().heightIn(min = LpSpacing.Touch).glass().padding(4.dp)) {
        val segW = maxWidth / options.size.coerceAtLeast(1)
        Box(
            Modifier.width(segW).height(40.dp)
                .graphicsLayer { translationX = pos * segW.toPx() }
                .shadow(4.dp, LpShapes.Pill, ambientColor = c.shadow, spotColor = c.shadow).clip(LpShapes.Pill).background(thumb),
        )
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            options.forEachIndexed { i, label ->
                val on = i == selectedIndex
                val col by animateColorAsState(if (on) onThumb else c.soft, label = "seg")
                Box(
                    Modifier.weight(1f).height(40.dp).clip(LpShapes.Pill)
                        .clickable(role = Role.Tab) { if (!on) haptics.tick(); onSelect(i) }.semantics { selected = on }.padding(horizontal = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(label, style = LpType.Body.copy(fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium), color = col, maxLines = 1, textAlign = TextAlign.Center)
                }
            }
        }
    }
}
