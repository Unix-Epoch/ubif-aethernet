package dev.aethernet.linkpearl.feature.update

import android.app.NotificationManager
import dev.aethernet.linkpearl.BuildConfig
import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.data.SessionStore
import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.FeatureModule
import dev.aethernet.linkpearl.core.nav.NavDots
import dev.aethernet.linkpearl.core.nav.TopLevel
import dev.aethernet.linkpearl.core.prefs.AppPrefs
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import java.io.File

/** In-app updates: the controller, the real downloader and installer, and the Settings dot in the nav. Installed by SettingsModule. */
object UpdateModule : FeatureModule {
    override fun install(c: AppContainer) {
        val app = c.application
        c.channel(AppContainer.ChannelSpec(UpdateNotice.CHANNEL, "Updates", NotificationManager.IMPORTANCE_DEFAULT))
        UpdateNotice.clearInstalled(app, BuildConfig.VERSION_CODE)
        c.provide<UpdateController> {
            UpdateController(
                current = AppVersion(BuildConfig.VERSION_CODE, BuildConfig.VERSION_NAME),
                source = ApiUpdateSource(c.get<ApiClient>()),
                downloader = OkHttpApkDownloader(
                    baseUrl = BuildConfig.API_BASE_URL, appKey = BuildConfig.APP_KEY,
                    credentials = { c.get<SessionStore>().current.credentials },
                    userAgent = "Linkpearl/" + BuildConfig.VERSION_NAME,
                    appVersion = BuildConfig.VERSION_NAME + "+" + BuildConfig.VERSION_CODE,
                ),
                installer = PackageInstallerApkInstaller(app),
                store = DataStoreUpdateStore(app),
                dir = File(app.cacheDir, "update"),
                scope = c.appScope,
                autoUpdate = { c.get<AppPrefs>().autoUpdate.first() },
            )
        }
        c.provide<NavDots> {
            val controller = c.get<UpdateController>()
            object : NavDots {
                override val dots: StateFlow<Set<TopLevel>> = controller.state
                    .map { if (it.available) setOf(TopLevel.Settings) else emptySet() }
                    .stateIn(c.appScope, SharingStarted.Eagerly, emptySet())
            }
        }
    }
}
