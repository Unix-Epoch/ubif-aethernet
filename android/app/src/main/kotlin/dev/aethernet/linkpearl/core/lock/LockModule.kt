package dev.aethernet.linkpearl.core.lock

import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.FeatureModule

/** Owner: agent B. Provide the real AppLock (30-minute idle timeout, biometric/passphrase unlock). */
object LockModule : FeatureModule {
    override fun install(c: AppContainer) {
        c.provide<AppLock> { StubAppLock() }
    }
}
