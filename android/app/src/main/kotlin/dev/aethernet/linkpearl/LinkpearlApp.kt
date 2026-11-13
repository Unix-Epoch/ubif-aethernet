package dev.aethernet.linkpearl

import android.app.Application
import androidx.work.Configuration
import dev.aethernet.linkpearl.core.di.AllModules
import dev.aethernet.linkpearl.core.di.AppContainer

/** Builds the service locator and lets every module fill its slots. Nothing feature-specific belongs here. */
class LinkpearlApp : Application(), Configuration.Provider {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        AllModules.forEach { it.install(container) }
        container.createNotificationChannels()
    }

    // WorkManager gets its worker factory from the container so feature modules can add their own workers.
    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder().setWorkerFactory(container.workerFactory).build()
}
