package dev.aethernet.linkpearl.core.lock

import android.os.SystemClock
import dev.aethernet.linkpearl.core.data.Auth
import dev.aethernet.linkpearl.core.data.DeviceIdentity
import dev.aethernet.linkpearl.core.data.StoreKeys
import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.FeatureModule

/** Owner: agent B. The real AppLock (system prompt, Keystore unwrap, 30-minute idle and 60-second background re-lock). */
object LockModule : FeatureModule {
    override fun install(c: AppContainer) {
        var lock: RealAppLock? = null
        // Registered at install (Application.onCreate, before any activity) so foreground/background counting starts at zero.
        val tracker = ActivityTracker(onBackground = { lock?.onBackground() }, onForeground = { lock?.onForeground() })
        c.application.registerActivityLifecycleCallbacks(tracker)
        c.provide<AppLock> {
            RealAppLock(
                scope = c.appScope,
                // Resolved on use: agent A's DataModule provides these.
                storeKeys = { c.get<StoreKeys>() },
                identity = { c.get<DeviceIdentity>() },
                auth = { c.get<Auth>() },
                prompt = SystemUnlockPrompt { tracker.current },
                clock = SystemClock::elapsedRealtime,
            ).also { lock = it }
        }
    }
}
