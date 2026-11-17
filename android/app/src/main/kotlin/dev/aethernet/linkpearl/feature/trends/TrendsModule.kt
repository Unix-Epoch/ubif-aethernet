package dev.aethernet.linkpearl.feature.trends

import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.FeatureModule

/** The Trends repository (nothing cached on the phone). */
object TrendsModule : FeatureModule {
    override fun install(c: AppContainer) {
        c.provide<TrendsRepository> { RealTrendsRepository(c.get<ApiClient>()) }
    }
}
