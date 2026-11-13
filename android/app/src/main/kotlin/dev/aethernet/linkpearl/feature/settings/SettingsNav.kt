package dev.aethernet.linkpearl.feature.settings

import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import androidx.navigation.navDeepLink
import dev.aethernet.linkpearl.core.nav.Routes

/** Settings' destinations (agent D). */
fun NavGraphBuilder.settingsGraph() {
    composable(Routes.SETTINGS, deepLinks = listOf(navDeepLink { uriPattern = Routes.deepLink(Routes.SETTINGS) })) { SettingsScreen() }
}
