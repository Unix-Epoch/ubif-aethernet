package dev.aethernet.linkpearl.feature.workorders

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpCard
import dev.aethernet.linkpearl.core.design.LpIcon
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.design.PillButton
import dev.aethernet.linkpearl.core.design.Tone
import dev.aethernet.linkpearl.core.design.bg
import dev.aethernet.linkpearl.core.design.fg
import dev.aethernet.linkpearl.core.lock.UnlockAttempt
import dev.aethernet.linkpearl.core.lock.UnlockProblem
import dev.aethernet.linkpearl.core.nav.LocalAdaptive
import kotlinx.coroutines.delay
import java.time.ZoneId
import kotlin.time.Duration

/** The clock the screens format against. Tests pass a fixed one with [ticks] off. */
data class WoClock(val now: () -> Long = System::currentTimeMillis, val zone: ZoneId = ZoneId.systemDefault(), val ticks: Boolean = true)

val LocalWoClock = staticCompositionLocalOf { WoClock() }

/** Server-corrected "now", refreshed every 30 s so times in status stay live. */
@Composable
fun rememberNowMs(skewMs: Long): Long {
    val clock = LocalWoClock.current
    var now by remember { mutableLongStateOf(clock.now()) }
    if (clock.ticks) LaunchedEffect(clock) { while (true) { delay(30_000); now = clock.now() } }
    return now + skewMs
}

/** Every pointer event on unlocked content restarts the idle timer (observed, never consumed). */
fun Modifier.onAnyTouch(onTouch: () -> Unit): Modifier = pointerInput(onTouch) {
    awaitPointerEventScope { while (true) { awaitPointerEvent(PointerEventPass.Initial); onTouch() } }
}

fun laneTone(lane: String?): Tone = when (Lane.of(lane)) {
    Lane.Order -> Tone.Warn
    Lane.Start -> Tone.Info
    Lane.Work -> Tone.Lilac
    Lane.Wait -> Tone.Teal
    Lane.Rfp -> Tone.Good
    null -> Tone.Neutral
}

/** Status in words with the lane's colour dot. */
@Composable
fun StatusChip(status: String?, lane: String?, modifier: Modifier = Modifier) {
    val tone = laneTone(lane)
    val text = status ?: Lane.of(lane)?.label ?: "Unknown status"
    Row(
        modifier.background(tone.bg(), LpShapes.Pill).padding(start = 10.dp, end = 12.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.size(9.dp).clip(CircleShape).background(tone.fg()))
        Text(text, style = LpType.Chip, color = tone.fg(), maxLines = 1)
    }
}

/** "5d 0h" with the clock icon; three days or more in bold amber. */
@Composable
fun TimeInStatus(since: String?, nowMs: Long, modifier: Modifier = Modifier) {
    val long = WoFmt.isLong(since, nowMs)
    val color = if (long) Lp.colors.warn else Lp.colors.soft
    val text = WoFmt.inStatus(since, nowMs)
    Row(modifier.semantics(mergeDescendants = true) { contentDescription = "In status $text" }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        LpIcon(LpIcons.Clock, null, size = 20.dp, tint = color)
        Text(text, style = if (long) LpType.BodyStrong else LpType.Body, color = color, maxLines = 1)
    }
}

/** The header lock control: "Unlock" when locked, "Lock · 28:14" counting down when unlocked. */
@Composable
fun LockControl(unlocked: Boolean, remaining: Duration?, onUnlock: () -> Unit, onLock: () -> Unit, modifier: Modifier = Modifier) {
    val c = Lp.colors
    val label = if (unlocked) "Lock · ${WoFmt.countdown(remaining)}" else "Unlock"
    Row(
        modifier.heightIn(min = LpSpacing.Touch).clip(LpShapes.Pill).background(if (unlocked) c.accSoft else c.surf3)
            .clickable(role = Role.Button, onClickLabel = if (unlocked) "Lock customer details" else "Unlock customer details", onClick = if (unlocked) onLock else onUnlock)
            .padding(horizontal = 18.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        val tint = if (unlocked) c.onAccSoft else c.fg
        LpIcon(if (unlocked) LpIcons.Unlock else LpIcons.Lock, null, size = 20.dp, tint = tint)
        Text(label, style = LpType.BodyStrong, color = tint, maxLines = 1)
    }
}

/** "Locks in 28:14" on the detail. */
@Composable
fun LocksInChip(remaining: Duration?, modifier: Modifier = Modifier) {
    val c = Lp.colors
    Row(
        modifier.heightIn(min = 40.dp).background(c.accSoft, LpShapes.Pill).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        LpIcon(LpIcons.Unlock, null, size = 20.dp, tint = c.onAccSoft)
        Text("Locks in ${WoFmt.countdown(remaining)}", style = LpType.BodyStrong, color = c.onAccSoft, maxLines = 1)
    }
}

/** Outlined pill button (Call, Text, Clear). [tall] = the big tabletop button with the icon above the label. */
@Composable
fun OutlineButton(text: String, icon: ImageVector?, onClick: () -> Unit, modifier: Modifier = Modifier, tall: Boolean = false, filled: Boolean = false) {
    val c = Lp.colors
    val fg = if (filled) c.onAcc else c.fg
    val shape = if (tall) LpShapes.Card else LpShapes.Pill
    val base = modifier.heightIn(min = if (tall) 96.dp else LpSpacing.Touch).clip(shape)
        .let { if (filled) it.background(c.acc) else it.border(1.5.dp, c.outline, shape) }
        .clickable(role = Role.Button, onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp)
    if (tall) {
        Column(base, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically)) {
            if (icon != null) LpIcon(icon, null, size = 28.dp, tint = fg)
            Text(text, style = LpType.Row.copy(fontWeight = FontWeight.SemiBold), color = fg, maxLines = 1)
        }
    } else {
        Row(base, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally)) {
            if (icon != null) LpIcon(icon, null, size = 22.dp, tint = fg)
            Text(text, style = LpType.BodyStrong, color = fg, maxLines = 1)
        }
    }
}

/** A round tinted icon badge (lock circle, no-results magnifier). */
@Composable
fun IconBadge(icon: ImageVector, size: Dp = 72.dp, tint: Color = Lp.colors.onAccSoft, background: Color = Lp.colors.accSoft) {
    Box(Modifier.size(size).clip(CircleShape).background(background), contentAlignment = Alignment.Center) {
        LpIcon(icon, null, size = size * 0.42f, tint = tint)
    }
}

/**
 * The in-app part of unlocking: shown over the screen while the system prompt is up (the prompt draws on top of it) and, if the
 * attempt fails, with the reason in one line and what to do. [onRegisterAgain] is offered when the device key is gone.
 */
@Composable
fun UnlockOverlay(attempt: UnlockAttempt, onRetry: () -> Unit, onDismiss: () -> Unit, onRegisterAgain: () -> Unit, modifier: Modifier = Modifier) {
    if (attempt == UnlockAttempt.Idle) return
    val c = Lp.colors
    // Two panes: the panel sits over the detail pane, never across the fold.
    val wide = LocalAdaptive.current.isTwoPane
    Row(modifier.fillMaxSize().background(c.shade).clickable(onClickLabel = "Close", role = Role.Button, onClick = onDismiss), verticalAlignment = Alignment.CenterVertically) {
        if (wide) Spacer(Modifier.weight(1f))
        Box(Modifier.weight(1f), contentAlignment = Alignment.Center) { UnlockPanel(attempt, onRetry, onDismiss, onRegisterAgain) }
    }
}

@Composable
private fun UnlockPanel(attempt: UnlockAttempt, onRetry: () -> Unit, onDismiss: () -> Unit, onRegisterAgain: () -> Unit) {
    val c = Lp.colors
    run {
        LpCard(Modifier.widthIn(max = 420.dp).padding(LpSpacing.L).clickable(enabled = false) {}, padding = 24.dp) {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(LpSpacing.L)) {
                IconBadge(LpIcons.Lock)
                Text("Unlock customer details", style = LpType.Title, color = c.fg, textAlign = TextAlign.Center)
                val failed = attempt as? UnlockAttempt.Failed
                if (failed != null) {
                    Text(problemLine(failed.problem), style = LpType.Body, color = c.fg, textAlign = TextAlign.Center)
                    Row(horizontalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
                        OutlineButton("Close", null, onDismiss)
                        when (failed.problem) {
                            UnlockProblem.KeyInvalidated -> PillButton("Register again", onRegisterAgain)
                            UnlockProblem.NoScreenLock, UnlockProblem.LockoutPermanent -> Unit
                            else -> PillButton("Try again", onRetry, icon = LpIcons.Unlock)
                        }
                    }
                }
            }
        }
    }
}

fun problemLine(p: UnlockProblem): String = when (p) {
    UnlockProblem.NoScreenLock -> "Set a screen lock on this phone first."
    UnlockProblem.Lockout -> "Too many tries. Wait, then try again."
    UnlockProblem.LockoutPermanent -> "Too many tries. Unlock the phone with its PIN first."
    UnlockProblem.KeyInvalidated -> "This phone must be registered again."
    UnlockProblem.Offline -> "Offline"
    UnlockProblem.Failed -> "Couldn't unlock"
}

fun problemText(p: Problem?): String = when (p) {
    Problem.Offline -> "Offline"
    Problem.Forbidden -> "Not your store"
    Problem.NoKey -> "No key for this store"
    Problem.RateLimited -> "Too many requests"
    Problem.SignedOut -> "Signed out"
    Problem.NotFound -> "No such work order"
    Problem.NotSetUp -> "Not connected yet"
    Problem.Server, null -> "Couldn't load"
}

fun canRetry(p: Problem?): Boolean = p != Problem.SignedOut && p != Problem.Forbidden && p != Problem.NotFound

/** A labelled value for the detail grid ("Program" / "Out Of Warranty"). */
@Composable
fun LabelValue(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(label, style = LpType.Small, color = Lp.colors.soft)
        Text(value, style = LpType.Row.copy(fontWeight = FontWeight.SemiBold), color = Lp.colors.fg, maxLines = 2)
    }
}

/** Static placeholder bars (the locked customer block, the locked row). */
@Composable
fun Bar(width: Dp, modifier: Modifier = Modifier, height: Dp = 12.dp) {
    Box(modifier.size(width, height).background(Lp.colors.surf3, LpShapes.Pill))
}

// ---- intents (no CALL / SMS permissions) ----------------------------------------------------------------------------------------

fun Context.dial(digits: String) = launch(Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", digits, null)))
fun Context.text(digits: String) = launch(Intent(Intent.ACTION_SENDTO, Uri.fromParts("smsto", digits, null)))
fun Context.openPortal(wo: Long) = launch(Intent(Intent.ACTION_VIEW, Uri.parse(WoFmt.portalUrl(wo))))

private fun Context.launch(i: Intent) {
    try { startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: ActivityNotFoundException) {}
}

@Composable
internal fun VSpace(h: Dp) = Box(Modifier.height(h))
