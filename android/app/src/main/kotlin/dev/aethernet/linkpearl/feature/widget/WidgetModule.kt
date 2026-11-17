package dev.aethernet.linkpearl.feature.widget

import dev.aethernet.linkpearl.core.data.Auth
import dev.aethernet.linkpearl.core.data.AuthState
import dev.aethernet.linkpearl.core.data.EncryptedFile
import dev.aethernet.linkpearl.core.data.HomeRepository
import dev.aethernet.linkpearl.core.data.RealHomeRepository
import dev.aethernet.linkpearl.core.data.keystoreBox
import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.FeatureModule
import dev.aethernet.linkpearl.feature.home.StorePreference
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import java.io.File

/**
 * Home-screen widgets ("Linkpearl" and "Today's sales"). Installed after DataModule (by SettingsModule): it wraps the app's
 * [HomeRepository] so every Home answer also reaches the widgets, and adds the 30-minute refresh job's worker factory.
 */
object WidgetModule : FeatureModule {
    override fun install(c: AppContainer) {
        val app = c.application
        c.provide<WidgetSnapshots> { WidgetSnapshots(EncryptedFile(File(app.filesDir, "lp-widgets.bin"), keystoreBox("linkpearl-data-v1"))) }
        c.provide<WidgetConfig> { DataStoreWidgetConfig(app) }
        c.provide<WidgetRefresher> {
            WidgetRefresher(
                hosts = GlanceWidgetHosts(app), home = c.get<RealHomeRepository>(), config = c.get<WidgetConfig>(),
                snapshots = c.get<WidgetSnapshots>(), homeScope = c.get<StorePreference>().scope, scope = c.appScope,
                signedIn = c.get<Auth>().state.map { it is AuthState.Registered },
            )
        }
        c.provide<HomeRepository> { WidgetFeedingHomeRepository(c.get<RealHomeRepository>()) { scope, data -> c.get<WidgetRefresher>().onHome(scope, data) } }
        c.workerFactory.addFactory(WidgetWorkerFactory { c.get<WidgetRefresher>() })

        // Signed in with widgets placed: keep the job scheduled. Signed out: the widgets forget their numbers and the job stops.
        c.appScope.launch {
            var wasRegistered = false
            c.get<Auth>().state.collect { s ->
                when (s) {
                    is AuthState.Registered -> {
                        wasRegistered = true
                        if (runCatching { GlanceWidgetHosts(app).appWidgetIds().isNotEmpty() }.getOrDefault(false)) WidgetScheduler.schedule(app)
                    }
                    is AuthState.Unregistered -> if (wasRegistered) {
                        wasRegistered = false
                        WidgetScheduler.cancel(app)
                        runCatching { c.get<WidgetRefresher>().clear() }
                    }
                    else -> Unit
                }
            }
        }
    }
}
