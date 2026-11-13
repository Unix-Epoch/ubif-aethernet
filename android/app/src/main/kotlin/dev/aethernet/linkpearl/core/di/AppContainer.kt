package dev.aethernet.linkpearl.core.di

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.work.DelegatingWorkerFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import java.util.concurrent.ConcurrentHashMap
import kotlin.reflect.KClass

/**
 * Application-level service locator (manual DI). Nobody edits this file.
 *
 * Each package fills its own slots from its own `*Module` object (see [FeatureModule]); `Modules.kt` lists the modules once.
 * Services are created lazily on first [get] and live as long as the process. A later [provide] for the same type replaces an
 * earlier one (so a feature module can swap the fake for the real implementation).
 */
class AppContainer(val application: Application) {
    val appScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val factories = ConcurrentHashMap<KClass<*>, () -> Any>()
    private val instances = ConcurrentHashMap<KClass<*>, Any>()

    /** WorkManager asks this factory for workers; a module adds its own with `workerFactory.addFactory(...)` (agent C). */
    val workerFactory = DelegatingWorkerFactory()

    private val channels = mutableListOf<ChannelSpec>()

    fun <T : Any> provide(type: KClass<T>, factory: () -> T) {
        factories[type] = factory
        instances.remove(type)
    }

    inline fun <reified T : Any> provide(noinline factory: () -> T) = provide(T::class, factory)

    @Suppress("UNCHECKED_CAST")
    fun <T : Any> get(type: KClass<T>): T = instances.getOrPut(type) {
        (factories[type] ?: error("Nothing provides ${type.simpleName}. Fill the slot in a FeatureModule (core/di/Modules.kt lists them)."))()
    } as T

    inline fun <reified T : Any> get(): T = get(T::class)

    /** A notification channel to create at startup (agent C). */
    fun channel(spec: ChannelSpec) { channels += spec }

    internal fun createNotificationChannels() {
        val nm = application.getSystemService(NotificationManager::class.java)
        channels.forEach { nm.createNotificationChannel(NotificationChannel(it.id, it.name, it.importance)) }
    }

    data class ChannelSpec(val id: String, val name: String, val importance: Int)
}

/** A package's contribution to the container: provide its services, worker factories and notification channels. */
interface FeatureModule {
    fun install(c: AppContainer)
}

/** Composables reach services through this (set in MainActivity). Prefer passing what a screen needs through its ViewModel. */
val LocalAppContainer = staticCompositionLocalOf<AppContainer> { error("No AppContainer provided") }
