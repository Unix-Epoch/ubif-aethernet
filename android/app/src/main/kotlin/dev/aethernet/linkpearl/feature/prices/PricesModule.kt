package dev.aethernet.linkpearl.feature.prices

import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.FeatureModule

/** The Prices repository (the device list kept in memory per store; nothing on disk). */
object PricesModule : FeatureModule {
    override fun install(c: AppContainer) {
        c.provide<PricesRepository> { RealPricesRepository(c.get<ApiClient>()) }
    }
}
