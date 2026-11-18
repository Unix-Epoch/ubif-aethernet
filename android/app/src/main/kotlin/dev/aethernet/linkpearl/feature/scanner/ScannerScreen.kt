package dev.aethernet.linkpearl.feature.scanner

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpCard
import dev.aethernet.linkpearl.core.design.LpIconButton
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpSegmented
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.design.PillButton
import dev.aethernet.linkpearl.core.design.SliderRow
import dev.aethernet.linkpearl.core.design.SwitchRow
import dev.aethernet.linkpearl.core.nav.LocalNavInset
import java.util.Locale
import kotlin.math.roundToInt
import kotlin.math.roundToLong

data class ScannerActions(
    val onBack: () -> Unit = {},
    val onPick: (ScanKind) -> Unit = {},
    val onChange: (ScanTuning) -> Unit = {},
    val onArea: (ScanArea) -> Unit = {},
    val onCode: (String) -> Unit = {},
    val onReset: () -> Unit = {},
)

/**
 * Settings > Scanner, stateless: Labels / QR, the live viewfinder ([camera]; null = none) with its draggable area, the last code read
 * and the read count, then zoom, hold, repeat, light, vibrate and sound.
 */
@Composable
fun ScannerScreen(
    state: ScannerUi,
    actions: ScannerActions = ScannerActions(),
    modifier: Modifier = Modifier,
    camera: (@Composable (tuning: ScanTuning, onCode: (String) -> Unit, onArea: (ScanArea) -> Unit) -> Unit)? = null,
) {
    val c = Lp.colors
    val t = state.tuning
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = LpSpacing.Gutter - 4.dp, end = LpSpacing.Gutter, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            LpIconButton(LpIcons.Back, "Back", actions.onBack, Modifier.padding(end = 4.dp))
            Text("Scanner", style = LpType.Screen, color = c.fg, maxLines = 1, modifier = Modifier.weight(1f).semantics { heading() })
        }
        Column(Modifier.fillMaxWidth().padding(horizontal = LpSpacing.Gutter).padding(bottom = 24.dp + LocalNavInset.current), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
            LpSegmented(ScanKind.entries.map { it.label }, state.kind.ordinal, { actions.onPick(ScanKind.entries[it]) })
            Box(Modifier.fillMaxWidth().aspectRatio(1.3f).clip(LpShapes.Card).background(c.surf3)) {
                camera?.invoke(t, actions.onCode, actions.onArea)
                LpIconButton(
                    LpIcons.Flashlight, if (t.light) "Light off" else "Light on", { actions.onChange(t.copy(light = !t.light)) },
                    Modifier.align(Alignment.BottomStart).padding(6.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.45f)),
                    tint = if (t.light) c.warn else Color.White,
                )
                Text(
                    zoomText(t.zoom), style = LpType.Chip, color = Color.White,
                    modifier = Modifier.align(Alignment.BottomEnd).padding(10.dp).clip(RoundedCornerShape(12.dp)).background(Color.Black.copy(alpha = 0.45f)).padding(horizontal = 10.dp, vertical = 2.dp),
                )
            }
            state.lastCode?.let { code ->
                Row(
                    Modifier.fillMaxWidth().clip(LpShapes.Card).background(c.goodBg).padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LpSpacing.M),
                ) {
                    Text(code, style = LpType.BodyStrong.copy(fontFamily = FontFamily.Monospace), color = c.good, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Text(if (state.reads == 1) "1 read" else "${state.reads} reads", style = LpType.Caption, color = c.soft, maxLines = 1)
                }
            }
            LpCard(padding = 0.dp) {
                SliderRow("Zoom", t.zoom, { actions.onChange(t.copy(zoom = (it * 10).roundToInt() / 10f)) }, ScanTuning.ZOOM_MIN..ScanTuning.ZOOM_MAX, zoomText(t.zoom))
                Divider()
                SliderRow(
                    "Hold", t.hold.toFloat(), { actions.onChange(t.copy(hold = it.roundToInt())) },
                    ScanTuning.HOLD_MIN.toFloat()..ScanTuning.HOLD_MAX.toFloat(), t.hold.toString(), steps = ScanTuning.HOLD_MAX - ScanTuning.HOLD_MIN - 1,
                )
                Divider()
                SliderRow(
                    "Repeat", t.repeatMs / 1000f, { actions.onChange(t.copy(repeatMs = (it * 2).roundToLong() * 500)) },
                    ScanTuning.REPEAT_MIN / 1000f..ScanTuning.REPEAT_MAX / 1000f, secondsText(t.repeatMs),
                    steps = ((ScanTuning.REPEAT_MAX - ScanTuning.REPEAT_MIN) / 500 - 1).toInt(),
                )
                Divider()
                SwitchRow("Light", t.light, { actions.onChange(t.copy(light = it)) })
                Divider()
                SwitchRow("Vibrate", t.vibrate, { actions.onChange(t.copy(vibrate = it)) })
                Divider()
                SwitchRow("Sound", t.sound, { actions.onChange(t.copy(sound = it)) })
            }
            PillButton("Reset", actions.onReset, Modifier.fillMaxWidth(), tonal = true)
        }
    }
}

@Composable
private fun Divider() = HorizontalDivider(color = Lp.colors.line)

internal fun zoomText(zoom: Float): String = String.format(Locale.US, "%.1f×", zoom)

internal fun secondsText(ms: Long): String = if (ms % 1000 == 0L) "${ms / 1000} s" else String.format(Locale.US, "%.1f s", ms / 1000f)
