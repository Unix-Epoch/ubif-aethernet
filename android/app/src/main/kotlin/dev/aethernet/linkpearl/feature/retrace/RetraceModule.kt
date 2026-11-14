package dev.aethernet.linkpearl.feature.retrace

import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.FeatureModule

/** The Retrace repository (no cache, nothing on disk). The store choice is Work orders' own remembered one. */
object RetraceModule : FeatureModule {
    override fun install(c: AppContainer) {
        c.provide<RetraceRepository> { RetraceRepository(c.get<ApiClient>()) }
    }
}
