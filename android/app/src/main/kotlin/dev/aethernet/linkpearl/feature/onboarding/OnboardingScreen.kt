package dev.aethernet.linkpearl.feature.onboarding

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.clickable
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.aethernet.linkpearl.core.data.AuthIssue
import dev.aethernet.linkpearl.core.design.LpChip
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.design.NoticeLine
import dev.aethernet.linkpearl.core.design.PillButton
import dev.aethernet.linkpearl.core.design.Tone
import dev.aethernet.linkpearl.core.di.LocalAppContainer

/**
 * First run, waiting for approval, approved without stores. Shown by core/nav until the phone is registered, approved and has a store.
 * Polls the server while visible.
 */
@Composable
fun OnboardingScreen(modifier: Modifier = Modifier) {
    val container = LocalAppContainer.current
    val vm: OnboardingViewModel = viewModel(factory = OnboardingViewModel.factory(container))
    val ui by vm.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(vm, lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { vm.poll() } }
    OnboardingContent(ui, vm::setName, vm::register, vm::checkNow, vm::cancel, modifier)
}

/** The stateless screen (screenshots and tests draw this). */
@Composable
fun OnboardingContent(
    ui: OnboardingUi,
    onName: (String) -> Unit,
    onRegister: () -> Unit,
    onCheck: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = Lp.colors
    Box(modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing), contentAlignment = Alignment.Center) {
        Column(
            Modifier.widthIn(max = 420.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(LpSpacing.L),
        ) {
            PearlMark()
            when (ui.step) {
                OnboardingStep.FirstRun -> {
                    Text("Linkpearl", style = LpType.Value, color = c.fg, modifier = Modifier.semantics { heading() })
                    OutlinedTextField(
                        value = ui.name, onValueChange = onName, singleLine = true, label = { Text("Device name") }, modifier = Modifier.fillMaxWidth(),
                        textStyle = LpType.Body.copy(color = c.fg),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { onRegister() }),
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = c.acc, unfocusedBorderColor = c.outline, focusedLabelColor = c.accText, unfocusedLabelColor = c.soft,
                            cursorColor = c.acc, focusedTextColor = c.fg, unfocusedTextColor = c.fg,
                        ),
                    )
                    ui.issue?.let { Issue(it) }
                    PillButton(if (ui.busy) "Registering" else "Register", onRegister, Modifier.fillMaxWidth())
                }
                OnboardingStep.Waiting -> {
                    Text(ui.name, style = LpType.Title, color = c.fg, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
                    LpChip("Waiting", tone = Tone.Info, icon = LpIcons.Hourglass)
                    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("Fingerprint", style = LpType.Label, color = c.soft)
                        Text(
                            ui.fingerprint, style = LpType.Value, color = c.fg, textAlign = TextAlign.Center,
                            modifier = Modifier.semantics { contentDescription = "Fingerprint " + ui.fingerprint.replace("-", " ").toList().joinToString(" ") },
                        )
                    }
                    ui.issue?.let { Issue(it) }
                    PillButton(if (ui.busy) "Checking" else "Check now", onCheck, Modifier.fillMaxWidth(), tonal = true, icon = LpIcons.Refresh)
                    TextAction("Cancel", onCancel)
                }
                OnboardingStep.NoStores -> {
                    Text(ui.name, style = LpType.Title, color = c.fg, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
                    LpChip("No stores", tone = Tone.Warn, icon = LpIcons.Warning)
                    ui.issue?.let { Issue(it) }
                    PillButton(if (ui.busy) "Checking" else "Check now", onCheck, Modifier.fillMaxWidth(), tonal = true, icon = LpIcons.Refresh)
                    TextAction("Sign out", onCancel)
                }
            }
        }
    }
}

@Composable
private fun Issue(issue: AuthIssue) {
    NoticeLine(issueText(issue), if (issue == AuthIssue.Offline) LpIcons.WifiOff else LpIcons.Warning, Modifier.fillMaxWidth(), warn = issue != AuthIssue.Offline)
}

fun issueText(issue: AuthIssue): String = when (issue) {
    AuthIssue.Offline -> "Offline"
    AuthIssue.Server -> "Server error"
    AuthIssue.Limit -> "Too many phones waiting"
    AuthIssue.Refused -> "Registration refused"
    AuthIssue.Revoked -> "This phone was removed"
}

@Composable
private fun TextAction(text: String, onClick: () -> Unit) {
    Box(Modifier.heightIn(min = LpSpacing.Touch).clickable(role = Role.Button, onClick = onClick).padding(horizontal = 16.dp), contentAlignment = Alignment.Center) {
        Text(text, style = LpType.BodyStrong, color = Lp.colors.accText)
    }
}
