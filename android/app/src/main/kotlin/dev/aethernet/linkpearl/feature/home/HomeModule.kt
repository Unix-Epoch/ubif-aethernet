package dev.aethernet.linkpearl.feature.home

import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.FeatureModule

/** Home's remembered store choice. The HomeRepository comes from DataModule. */
object HomeModule : FeatureModule {
    override fun install(c: AppContainer) {
        c.provide<StorePreference> { DataStoreStorePreference(c.application) }
    }
}
