package dev.aethernet.linkpearl.core.data

import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.FeatureModule

/**
 * Owner: agent A. Replace the fakes below with the real implementations (ApiClient over OkHttp, Auth, DeviceIdentity on the
 * Android Keystore, and a HomeRepository that calls GET /api/m/home through ApiClient and keeps the last answer on disk).
 */
object DataModule : FeatureModule {
    override fun install(c: AppContainer) {
        c.provide<ApiClient> { UnconfiguredApiClient }
        c.provide<Auth> { FakeAuth() }
        c.provide<HomeRepository> { FakeHomeRepository() }
    }
}
