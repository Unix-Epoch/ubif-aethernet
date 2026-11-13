package dev.aethernet.linkpearl.core.nav

import androidx.activity.compose.BackHandler
import androidx.compose.material3.adaptive.layout.AnimatedPane
import androidx.compose.material3.adaptive.layout.HingePolicy
import androidx.compose.material3.adaptive.layout.ListDetailPaneScaffold
import androidx.compose.material3.adaptive.layout.ListDetailPaneScaffoldRole
import androidx.compose.material3.adaptive.layout.calculatePaneScaffoldDirective
import androidx.compose.material3.adaptive.navigation.rememberListDetailPaneScaffoldNavigator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import kotlinx.coroutines.launch

/**
 * List-detail scaffold for Alerts and the phone Work orders flow: always one pane at a time (the directive is forced to one horizontal
 * partition, so wide screens behave like phones).
 *
 * - [list] gets `select(item)`: call it when a row is tapped. On a phone this shows the detail pane; the system back gesture returns.
 * - [detail] is called with the selected item. [emptyDetail] is unused with one pane but kept for the signature.
 *
 * Deep links such as `workorders/{id}` should call `select` from a LaunchedEffect.
 */
@Composable
fun <T : Any> LpListDetail(
    list: @Composable (select: (T) -> Unit) -> Unit,
    detail: @Composable (item: T) -> Unit,
    modifier: Modifier = Modifier,
    initialSelection: T? = null,
    emptyDetail: @Composable () -> Unit = {},
) {
    // One pane at a time at every width: the detail replaces the list and the system back gesture returns.
    val base = calculatePaneScaffoldDirective(LocalAdaptive.current.info, HingePolicy.NeverAvoid)
    val directive = base.copy(maxHorizontalPartitions = 1)
    val navigator = rememberListDetailPaneScaffoldNavigator<T>(scaffoldDirective = directive)
    val scope = rememberCoroutineScope()
    androidx.compose.runtime.LaunchedEffect(initialSelection) { initialSelection?.let { navigator.navigateTo(ListDetailPaneScaffoldRole.Detail, it) } }
    BackHandler(enabled = navigator.canNavigateBack()) { scope.launch { navigator.navigateBack() } }
    ListDetailPaneScaffold(
        directive = navigator.scaffoldDirective,
        scaffoldState = navigator.scaffoldState,
        modifier = modifier,
        listPane = { AnimatedPane { list { item -> scope.launch { navigator.navigateTo(ListDetailPaneScaffoldRole.Detail, item) } } } },
        detailPane = {
            AnimatedPane {
                val item = navigator.currentDestination?.contentKey
                if (item != null) detail(item) else emptyDetail()
            }
        },
    )
}
