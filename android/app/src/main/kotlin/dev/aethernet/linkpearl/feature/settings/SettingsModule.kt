package dev.aethernet.linkpearl.feature.settings

import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.FeatureModule
import dev.aethernet.linkpearl.core.prefs.PrefsModule

/** Owner: agent D. Installs the app preferences (core/prefs) so every feature can read them. */
object SettingsModule : FeatureModule {
    override fun install(c: AppContainer) {
        PrefsModule.install(c)
    }
}
