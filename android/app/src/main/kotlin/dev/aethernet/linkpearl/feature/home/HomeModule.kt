package dev.aethernet.linkpearl.feature.home

import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.FeatureModule

/** Owner: agent A (wires Home to the real API: replace the HomeRepository in DataModule; Home itself is finished). */
object HomeModule : FeatureModule {
    override fun install(c: AppContainer) {
        c.provide<StorePreference> { DataStoreStorePreference(c.application) }
    }
}
