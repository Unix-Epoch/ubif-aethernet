package dev.aethernet.linkpearl.feature.settings

import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.FeatureModule
import dev.aethernet.linkpearl.core.prefs.PrefsModule
import dev.aethernet.linkpearl.feature.scanner.ScannerModule
import dev.aethernet.linkpearl.feature.update.UpdateModule
import dev.aethernet.linkpearl.feature.widget.WidgetModule

/**
 * Owner: agent D. Installs the app preferences (core/prefs) so every feature can read them, in-app updates (feature/update, shown in
 * Settings' About) and the home-screen widgets (feature/widget; installed last so its Home hook wraps DataModule's repository).
 */
object SettingsModule : FeatureModule {
    override fun install(c: AppContainer) {
        PrefsModule.install(c)
        UpdateModule.install(c)
        ScannerModule.install(c)
        WidgetModule.install(c)
    }
}
