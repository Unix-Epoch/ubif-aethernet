package dev.aethernet.linkpearl.core.data

import android.app.Application
import dev.aethernet.linkpearl.BuildConfig
import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.FeatureModule
import kotlinx.coroutines.launch
import java.io.File

/**
 * Owner: agent A. The real services: encrypted session storage, the Keystore device identity, the OkHttp API client, registration
 * ([RealAuth]), wrapped store keys, and Home on live data. The fakes stay in the package for tests and screenshots.
 */
object DataModule : FeatureModule {
    override fun install(c: AppContainer) {
        val app: Application = c.application
        c.provide<SessionStore> { SessionStore(EncryptedFile(File(app.filesDir, "lp-session.bin"), keystoreBox("linkpearl-data-v1"))) }
        c.provide<DeviceIdentity> { KeystoreDeviceIdentity(app, c.get<SessionStore>()) }
        c.provide<OkHttpApiClient> {
            val session = c.get<SessionStore>()
            OkHttpApiClient(
                baseUrl = BuildConfig.API_BASE_URL, appKey = BuildConfig.APP_KEY,
                credentials = { session.current.credentials },
                hooks = { c.get<Auth>() as? SessionHooks },
                userAgent = "Linkpearl/" + BuildConfig.VERSION_NAME,
            )
        }
        c.provide<ApiClient> { c.get<OkHttpApiClient>() }
        c.provide<RealHomeRepository> {
            RealHomeRepository(
                api = c.get<ApiClient>(),
                cache = EncryptedFile(File(app.filesDir, "lp-home.bin"), keystoreBox("linkpearl-data-v1")),
                onStores = { stores -> (c.get<Auth>() as? RealAuth)?.rememberStoreNames(stores) },
            )
        }
        c.provide<HomeRepository> { c.get<RealHomeRepository>() }
        c.provide<RealAuth> {
            val identity = c.get<DeviceIdentity>()
            RealAuth(
                store = c.get<SessionStore>(), transport = c.get<OkHttpApiClient>(), identity = identity,
                resetKey = { (identity as? ManagedIdentity)?.reset() },
                wipeData = { c.get<RealHomeRepository>().clear() },
                scope = c.appScope,
            ).also { auth -> c.appScope.launch { auth.refresh() } } // the owner may have changed the stores since last launch
        }
        c.provide<Auth> { c.get<RealAuth>() }
        c.provide<AuthIssues> { c.get<RealAuth>() }
        c.provide<StoreKeys> { RealStoreKeys(c.get<SessionStore>(), c.get<Auth>()) }
    }
}
