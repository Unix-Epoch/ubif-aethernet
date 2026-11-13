package dev.aethernet.linkpearl.core.nav

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.Badge
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteDefaults
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteItem
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteType
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpIcon
import dev.aethernet.linkpearl.core.design.LpType

/**
 * The app chrome: bottom bar on compact width, navigation rail from 600dp (Material 3 adaptive navigation suite). Stateless so the
 * screenshot tests can draw it with any content.
 *
 * [showBar] hides the bottom bar on phone-width detail screens (the rail stays on wide screens, as in the mockups).
 * Content gets the status-bar and side insets; the bar handles the bottom one.
 */
@Composable
fun LpNavScaffold(
    selected: TopLevel?,
    onSelect: (TopLevel) -> Unit,
    modifier: Modifier = Modifier,
    badges: Map<TopLevel, Int> = emptyMap(),
    showBar: Boolean = true,
    content: @Composable () -> Unit,
) {
    val c = Lp.colors
    val adaptive = LocalAdaptive.current
    val layoutType = when {
        !adaptive.isCompact -> NavigationSuiteType.NavigationRail
        showBar -> NavigationSuiteType.NavigationBar
        else -> NavigationSuiteType.None
    }
    NavigationSuiteScaffold(
        modifier = modifier,
        navigationSuiteType = layoutType,
        navigationItemVerticalArrangement = Arrangement.spacedBy(12.dp),
        containerColor = c.page,
        contentColor = c.fg,
        navigationSuiteColors = NavigationSuiteDefaults.colors(
            navigationBarContainerColor = c.navBg, navigationBarContentColor = c.fg,
            navigationRailContainerColor = c.navBg, navigationRailContentColor = c.fg,
        ),
        navigationItems = {
            TopLevel.entries.forEach { dest ->
                val count = badges[dest] ?: 0
                val label = if (adaptive.isCompact) dest.label else dest.railLabel
                NavigationSuiteItem(
                    selected = dest == selected,
                    onClick = { onSelect(dest) },
                    icon = { LpIcon(dest.icon, null) },
                    modifier = if (count > 0) Modifier.semantics { contentDescription = "${dest.label}, $count unread" } else Modifier,
                    badge = if (count > 0) ({ Badge(containerColor = c.acc, contentColor = c.onAcc) { Text(count.toString(), style = LpType.Caption) } }) else null,
                    label = { Text(label, style = LpType.Caption, maxLines = 1) },
                )
            }
        },
    ) {
        val base = WindowInsetsSides.Top + WindowInsetsSides.Horizontal
        val sides = if (layoutType == NavigationSuiteType.NavigationBar) base else base + WindowInsetsSides.Bottom
        Box(Modifier.fillMaxSize().background(c.page).windowInsetsPadding(WindowInsets.safeDrawing.only(sides))) { content() }
    }
}
