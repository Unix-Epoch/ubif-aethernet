package dev.aethernet.linkpearl.feature.alerts

import android.app.Activity
import android.app.NotificationManager
import android.os.Bundle
import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.data.Auth
import dev.aethernet.linkpearl.core.data.AuthState
import dev.aethernet.linkpearl.core.data.StoreZone
import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.FeatureModule
import dev.aethernet.linkpearl.core.nav.NavBadges
import kotlinx.coroutines.launch

/** Owner: agent C. Alerts: the hub, the background check (WorkManager), notification channels, the nav badge. */
object AlertsModule : FeatureModule {
    override fun install(c: AppContainer) {
        val app = c.application
        c.provide<CheckState> { DataStoreCheckState(app) }
        c.provide<AlertNotifier> { AndroidAlertNotifier(app) }
        c.provide<AlertsHub> { AlertsHub(c.get<ApiClient>(), c.get<Auth>(), c.get<CheckState>(), c.get<AlertNotifier>(), c.appScope) }
        c.provide<NavBadges> { c.get<AlertsHub>().badge }

        // One channel per type: the owner can silence a type in Android's own settings.
        AlertType.configurableTypes.forEach { t ->
            c.channel(AppContainer.ChannelSpec(t.channelId!!, t.label, NotificationManager.IMPORTANCE_DEFAULT))
        }

        c.appScope.launch { c.get<StoreZone>().ids.collect { AlertText.TZ = it } }

        c.workerFactory.addFactory(AlertsWorkerFactory { c.get<AlertsHub>() })

        // Schedule when the phone is Registered; cancel (and forget the cursor of the old identity) when it is not.
        c.appScope.launch {
            var wasRegistered = false
            c.get<Auth>().state.collect { s ->
                val hub = c.get<AlertsHub>()
                when (s) {
                    is AuthState.Registered -> { wasRegistered = true; AlertsScheduler.schedule(app) }
                    else -> {
                        AlertsScheduler.cancel(app)
                        if (wasRegistered && s is AuthState.Unregistered) { wasRegistered = false; hub.check.clear(); hub.feed.signedOut() }
                    }
                }
            }
        }

        // Foreground refresh: when the first activity starts.
        app.registerActivityLifecycleCallbacks(object : android.app.Application.ActivityLifecycleCallbacks {
            private var started = 0
            override fun onActivityStarted(activity: Activity) { if (started++ == 0) c.get<AlertsHub>().onForeground() }
            override fun onActivityStopped(activity: Activity) { started = (started - 1).coerceAtLeast(0) }
            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
            override fun onActivityResumed(activity: Activity) {}
            override fun onActivityPaused(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
    }
}
