package dev.aethernet.linkpearl.feature.workorders

import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.FeatureModule

/** Owner: agent B. The work order repository (in-memory last list only) and the remembered store choice. */
object WorkOrdersModule : FeatureModule {
    override fun install(c: AppContainer) {
        c.provide<WoRepository> { WoRepository(c.get<ApiClient>()) }
        c.provide<WoStorePreference> { DataStoreWoStorePreference(c.application) }
    }
}
