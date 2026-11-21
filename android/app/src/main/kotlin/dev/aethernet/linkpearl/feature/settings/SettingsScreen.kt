package dev.aethernet.linkpearl.feature.settings

import dev.aethernet.linkpearl.core.nav.LocalNavInset
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.runtime.remember
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpCard
import dev.aethernet.linkpearl.core.design.LpChip
import dev.aethernet.linkpearl.core.design.LpDialog
import dev.aethernet.linkpearl.core.design.LpIcon
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpListRow
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.design.PillButton
import dev.aethernet.linkpearl.core.design.SwitchRow
import dev.aethernet.linkpearl.core.design.Tone
import dev.aethernet.linkpearl.core.nav.HingeTwoPane
import dev.aethernet.linkpearl.core.nav.LocalAdaptive
import androidx.compose.ui.text.font.FontWeight
import dev.aethernet.linkpearl.core.prefs.Appearance
import dev.aethernet.linkpearl.feature.update.CheckStatus
import dev.aethernet.linkpearl.feature.update.UpdatePhase
import dev.aethernet.linkpearl.feature.update.UpdateProgress
import dev.aethernet.linkpearl.feature.update.UpdateState

/** Everything a tap on Settings can do. Defaults do nothing so screenshot tests can leave them out. */
data class SettingsActions(
    val onToggleLock: () -> Unit = {},
    val onNotifications: () -> Unit = {},
    val onAlertSettings: () -> Unit = {},
    val onAppearance: (Appearance) -> Unit = {},
    val onUpdate: () -> Unit = {},
    val onCheckUpdates: () -> Unit = {},
    val onAutoUpdate: (Boolean) -> Unit = {},
    val onOpenAdmin: () -> Unit = {},
    val onLinkshell: () -> Unit = {},
    val onScanner: () -> Unit = {},
    val onVersionTap: () -> Unit = {},
    val onDeveloper: () -> Unit = {},
    val onAskForget: () -> Unit = {},
    val onCancelForget: () -> Unit = {},
    val onConfirmForget: () -> Unit = {},
)

@Composable
fun SettingsScreen(
    state: SettingsUiState = SettingsUiState(), version: String = "—", modifier: Modifier = Modifier, actions: SettingsActions = SettingsActions(),
    update: UpdateState? = null,
) {
    val wide = LocalAdaptive.current.isTwoPane
    val title = @Composable { Text("Settings", style = LpType.Screen, color = Lp.colors.fg, modifier = Modifier.heightIn(min = LpSpacing.Touch).semantics { heading() }) }
    val left = @Composable {
        DeviceSection(state, actions); CustomerSection(state, actions); NotificationsSection(state, actions)
    }
    val right = @Composable {
        AppearanceSection(state, actions); AboutSection(version, state.autoUpdate, state.developer, update, actions); ForgetSection(actions)
    }
    val gap = Arrangement.spacedBy(LpSpacing.Xl)
    val navInset = LocalNavInset.current
    if (!wide) {
        Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = LpSpacing.Gutter).padding(top = 8.dp, bottom = 24.dp + navInset), verticalArrangement = gap) {
            title(); left(); right()
        }
    } else {
        HingeTwoPane(
            modifier = modifier.fillMaxSize(),
            first = { Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = LpSpacing.Gutter).padding(top = 8.dp, bottom = 24.dp + navInset), verticalArrangement = gap) { title(); left() } },
            second = { Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(end = LpSpacing.Gutter).padding(top = 8.dp + LpSpacing.Touch + LpSpacing.Xl, bottom = 24.dp + navInset), verticalArrangement = gap) { right() } },
        )
    }
    if (state.confirmForget) LpDialog(onDismiss = actions.onCancelForget) { ForgetConfirm(actions) }
}

// ---- sections ------------------------------------------------------------------------------------------------------------------

@Composable
private fun Section(label: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(LpSpacing.S)) {
        Text(label.uppercase(), style = LpType.Label, color = Lp.colors.soft, modifier = Modifier.padding(start = 8.dp).semantics { heading() })
        LpCard(padding = 0.dp) { content() }
    }
}

@Composable
private fun Divider() = HorizontalDivider(color = Lp.colors.line)

@Composable
private fun Value(text: String) = Text(text, style = LpType.Body, color = Lp.colors.soft, maxLines = 1, overflow = TextOverflow.Ellipsis)

@Composable
private fun Lead(icon: ImageVector) = LpIcon(icon, null, tint = Lp.colors.soft)

@Composable
private fun Chevron() = LpIcon(LpIcons.ChevronRight, null, tint = Lp.colors.soft)

@Composable
private fun DeviceSection(s: SettingsUiState, a: SettingsActions) = Section("Device") {
    LpListRow(s.phoneName ?: "—", leading = { Lead(LpIcons.Phone) })
    s.stores.forEach { st ->
        Divider()
        LpListRow(st.label, leading = { Lead(LpIcons.Store) }, trailing = { st.updated?.let { Value(it) } })
    }
    Divider()
    LpListRow("Linkshell", leading = { Lead(LpIcons.Link) }, onClick = a.onLinkshell, trailing = { Chevron() })
    Divider()
    LpListRow("Scanner", leading = { Lead(LpIcons.Scan) }, onClick = a.onScanner, trailing = { Chevron() })
}

@Composable
private fun CustomerSection(s: SettingsUiState, a: SettingsActions) = Section("Customer details") {
    LpListRow(
        if (s.unlocked) "Unlocked" else "Locked",
        leading = { Lead(if (s.unlocked) LpIcons.Unlock else LpIcons.Lock) },
        trailing = { PillButton(if (s.unlocked) "Lock" else "Unlock", a.onToggleLock, tonal = true) },
    )
    Divider()
    LpListRow("Lock after", leading = { Lead(LpIcons.Clock) }, trailing = { Value(s.lockAfter) })
}

@Composable
private fun NotificationsSection(s: SettingsUiState, a: SettingsActions) = Section("Notifications") {
    LpListRow(
        "Notifications", leading = { Lead(LpIcons.Bell) },
        onClick = a.onNotifications.takeIf { s.notificationsOn },
        trailing = {
            if (s.notificationsOn) LpChip("On", tone = Tone.Good, icon = LpIcons.Check)
            else {
                LpChip("Off", tone = Tone.Warn, icon = LpIcons.Warning)
                PillButton("Turn on", a.onNotifications)
            }
        },
    )
    Divider()
    LpListRow("Alert settings", leading = { Lead(LpIcons.Sliders) }, onClick = a.onAlertSettings, trailing = { Chevron() })
}

@Composable
private fun AppearanceSection(s: SettingsUiState, a: SettingsActions) = Section("Appearance") {
    Row(Modifier.fillMaxWidth().padding(8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Segment("Dark", "Dark", s.appearance == Appearance.Dark) { a.onAppearance(Appearance.Dark) }
        Segment("Light", "Light", s.appearance == Appearance.Light) { a.onAppearance(Appearance.Light) }
        Segment("Phone", "Follow phone", s.appearance == Appearance.System) { a.onAppearance(Appearance.System) }
    }
}

@Composable
private fun RowScope.Segment(label: String, description: String, selected: Boolean, onClick: () -> Unit) {
    val c = Lp.colors
    Row(
        Modifier.weight(1f).heightIn(min = LpSpacing.Touch).background(if (selected) c.accSoft else androidx.compose.ui.graphics.Color.Transparent, LpShapes.Row)
            .selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
            .semantics { contentDescription = description }.padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
    ) {
        if (selected) LpIcon(LpIcons.Check, null, size = 20.dp, tint = c.onAccSoft)
        Text(label, style = if (selected) LpType.BodyStrong else LpType.Body, color = if (selected) c.onAccSoft else c.soft, maxLines = 1)
    }
}

@Composable
private fun AboutSection(version: String, autoUpdate: Boolean, developer: Boolean, update: UpdateState?, a: SettingsActions) = Section("About") {
    VersionRow(version, a.onVersionTap)
    Divider()
    SwitchRow("Auto-update", autoUpdate, a.onAutoUpdate)
    Divider()
    if (update != null && update.available) {
        UpdateRow(update, a.onUpdate)
        Divider()
    } else {
        val status = update?.checkStatus ?: CheckStatus.Idle
        LpListRow(
            "Check for updates", onClick = if (status == CheckStatus.Checking) null else a.onCheckUpdates,
            trailing = {
                when (status) {
                    CheckStatus.Checking -> Value("Checking…")
                    CheckStatus.UpToDate -> Value("Up to date")
                    CheckStatus.Failed -> Value("Couldn't check")
                    CheckStatus.Idle -> {}
                }
            },
        )
        Divider()
    }
    LpListRow("Open admin site", onClick = a.onOpenAdmin, trailing = { LpIcon(LpIcons.External, null, tint = Lp.colors.soft) })
    if (developer) {
        Divider()
        LpListRow("Developer", onClick = a.onDeveloper, trailing = { Chevron() })
    }
}

/** Version reads as plain text (no ripple, no button role); the taps still count toward the Developer row. */
@Composable
private fun VersionRow(version: String, onTap: () -> Unit) {
    val source = remember { MutableInteractionSource() }
    LpListRow("Version", Modifier.clickable(source, indication = null, onClick = onTap), trailing = { Value(version) })
}

/** The highlighted "new version" row: download icon, the version name, Update; the progress (or the error) below while it runs. */
@Composable
private fun UpdateRow(u: UpdateState, onUpdate: () -> Unit) {
    val c = Lp.colors
    Column(Modifier.fillMaxWidth().background(c.surf2).padding(horizontal = LpSpacing.L, vertical = LpSpacing.S)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
            LpIcon(LpIcons.Download, null, tint = c.acc)
            Text(
                u.latest?.name ?: "—", style = LpType.Row.copy(fontWeight = FontWeight.Bold), color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).semantics { contentDescription = "Version ${u.latest?.name} available" },
            )
            if (!u.busy) PillButton("Update", onUpdate)
        }
        if (u.phase !is UpdatePhase.Idle && u.phase != UpdatePhase.NeedsPermission) UpdateProgress(u.phase, Modifier.padding(bottom = LpSpacing.S))
    }
}

@Composable
private fun ForgetSection(a: SettingsActions) {
    LpCard(padding = 0.dp) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(role = Role.Button, onClick = a.onAskForget).padding(horizontal = LpSpacing.L, vertical = LpSpacing.S),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LpSpacing.M),
        ) {
            LpIcon(LpIcons.Warning, null, tint = Lp.colors.warn)
            Text("Forget this phone", style = LpType.BodyStrong, color = Lp.colors.warn)
        }
    }
}

/** The confirm dialog's content (also drawn directly by screenshot tests, which cannot capture dialog windows). */
@Composable
fun ForgetConfirm(a: SettingsActions) {
    val c = Lp.colors
    Column(Modifier.widthIn(max = 360.dp), verticalArrangement = Arrangement.spacedBy(LpSpacing.L)) {
        Text("Forget this phone", style = LpType.Title, color = c.fg, modifier = Modifier.semantics { heading() })
        Text("Removes this phone's access and deletes its keys.", style = LpType.Body, color = c.fg)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(LpSpacing.S, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
            PillButton("Cancel", a.onCancelForget, tonal = true)
            Row(
                Modifier.heightIn(min = LpSpacing.Touch).background(c.warnBg, LpShapes.Pill).clickable(role = Role.Button, onClick = a.onConfirmForget).padding(horizontal = 20.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                LpIcon(LpIcons.Warning, null, size = 20.dp, tint = c.warn)
                Text("Forget", style = LpType.BodyStrong, color = c.warn, maxLines = 1)
            }
        }
    }
}
