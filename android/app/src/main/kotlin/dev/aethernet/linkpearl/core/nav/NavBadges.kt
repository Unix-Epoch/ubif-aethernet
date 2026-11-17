package dev.aethernet.linkpearl.core.nav

import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.FeatureModule
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Counts shown on navigation items (the unread-alerts "3"). The alerts agent (C) provides the real source from `AlertsModule`
 * (`c.provide<NavBadges> { ... }`); until then a fixed fake keeps the chrome looking like the mockups.
 */
interface NavBadges {
    val counts: StateFlow<Map<TopLevel, Int>>
}

class FakeNavBadges(initial: Map<TopLevel, Int> = mapOf(TopLevel.Alerts to 3)) : NavBadges {
    override val counts: StateFlow<Map<TopLevel, Int>> = MutableStateFlow(initial)
}

/** Navigation items that show a small dot without a count (Settings when an app update is available; provided by feature/update). */
interface NavDots {
    val dots: StateFlow<Set<TopLevel>>
}

object NoNavDots : NavDots {
    override val dots: StateFlow<Set<TopLevel>> = MutableStateFlow(emptySet())
}

/** Scaffold-owned: registers the default badge source. */
object NavModule : FeatureModule {
    override fun install(c: AppContainer) {
        c.provide<NavBadges> { FakeNavBadges() }
        c.provide<NavDots> { NoNavDots }
    }
}
