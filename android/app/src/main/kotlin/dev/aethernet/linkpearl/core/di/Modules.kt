package dev.aethernet.linkpearl.core.di

import dev.aethernet.linkpearl.core.data.DataModule
import dev.aethernet.linkpearl.core.lock.LockModule
import dev.aethernet.linkpearl.core.nav.NavModule
import dev.aethernet.linkpearl.feature.alerts.AlertsModule
import dev.aethernet.linkpearl.feature.home.HomeModule
import dev.aethernet.linkpearl.feature.onboarding.OnboardingModule
import dev.aethernet.linkpearl.feature.retrace.RetraceModule
import dev.aethernet.linkpearl.feature.settings.SettingsModule
import dev.aethernet.linkpearl.feature.workorders.WorkOrdersModule

/**
 * The one list of modules, written once by the scaffold. Each module object lives in its owner's package and is the ONLY place that
 * owner registers services; install order below is the order of precedence (later providers replace earlier ones).
 *  - NavModule: default nav badge source (core/nav, scaffold-owned)
 *  - DataModule: ApiClient, Auth, DeviceIdentity, HomeRepository (agent A)
 *  - LockModule: AppLock (agent B)
 *  - HomeModule / OnboardingModule (agent A), WorkOrdersModule (B), RetraceModule, AlertsModule (C), SettingsModule (D)
 */
val AllModules: List<FeatureModule> = listOf(
    NavModule, DataModule, LockModule,
    HomeModule, OnboardingModule, WorkOrdersModule, RetraceModule, AlertsModule, SettingsModule,
)
