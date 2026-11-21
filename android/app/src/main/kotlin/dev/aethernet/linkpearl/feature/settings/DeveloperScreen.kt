package dev.aethernet.linkpearl.feature.settings

import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpCard
import dev.aethernet.linkpearl.core.design.LpIconButton
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.design.PillButton
import dev.aethernet.linkpearl.core.design.SwitchRow
import dev.aethernet.linkpearl.core.di.LocalAppContainer
import dev.aethernet.linkpearl.core.nav.LocalNavInset
import dev.aethernet.linkpearl.core.nav.Routes
import dev.aethernet.linkpearl.core.prefs.AppPrefs
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * Settings > Developer: per-phone switches for the developer, shown once Version has been tapped seven times. Nothing here reaches
 * other phones. Add a setting as one more AppPrefs flow, one field here and one row in its section.
 */
data class DeveloperUi(val allowCapture: Boolean = false)

data class DeveloperActions(
    val onBack: () -> Unit = {},
    val onAllowCapture: (Boolean) -> Unit = {},
    val onHide: () -> Unit = {},
)

class DeveloperViewModel(private val prefs: AppPrefs) : ViewModel() {
    val state: StateFlow<DeveloperUi> = prefs.allowCapture.map { DeveloperUi(allowCapture = it) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, DeveloperUi())

    fun setAllowCapture(value: Boolean) { viewModelScope.launch { prefs.setAllowCapture(value) } }

    /** Hides the Developer row and turns its switches back to their defaults, so a hidden menu never leaves anything changed. */
    fun hide() { viewModelScope.launch { prefs.setAllowCapture(false); prefs.setDeveloper(false) } }
}

/** `settings/developer`, opened from Settings > About > Developer. No deep link: only reachable through Settings. */
fun NavGraphBuilder.developerGraph() {
    composable(Routes.DEVELOPER) { DeveloperRoute() }
}

@Composable
fun DeveloperRoute() {
    val c = LocalAppContainer.current
    val back = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
    val vm: DeveloperViewModel = viewModel(factory = viewModelFactory { initializer { DeveloperViewModel(c.get()) } })
    val ui by vm.state.collectAsStateWithLifecycle()
    DeveloperScreen(
        ui,
        DeveloperActions(
            onBack = { back?.onBackPressed() },
            onAllowCapture = vm::setAllowCapture,
            onHide = { vm.hide(); back?.onBackPressed() },
        ),
    )
}

@Composable
fun DeveloperScreen(state: DeveloperUi, actions: DeveloperActions = DeveloperActions(), modifier: Modifier = Modifier) {
    val c = Lp.colors
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = LpSpacing.Gutter - 4.dp, end = LpSpacing.Gutter, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            LpIconButton(LpIcons.Back, "Back", actions.onBack, Modifier.padding(end = 4.dp))
            Text("Developer", style = LpType.Screen, color = c.fg, maxLines = 1, modifier = Modifier.weight(1f).semantics { heading() })
        }
        Column(
            Modifier.fillMaxWidth().padding(horizontal = LpSpacing.Gutter).padding(top = LpSpacing.M, bottom = 24.dp + LocalNavInset.current),
            verticalArrangement = Arrangement.spacedBy(LpSpacing.Xl),
        ) {
            DevSection("Work orders") {
                SwitchRow("Allow screen capture", state.allowCapture, actions.onAllowCapture)
            }
            PillButton("Hide developer menu", actions.onHide, Modifier.fillMaxWidth(), tonal = true)
        }
    }
}

@Composable
private fun DevSection(label: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(LpSpacing.S)) {
        Text(label.uppercase(), style = LpType.Label, color = Lp.colors.soft, modifier = Modifier.padding(start = 8.dp).semantics { heading() })
        LpCard(padding = 0.dp) { content() }
    }
}
