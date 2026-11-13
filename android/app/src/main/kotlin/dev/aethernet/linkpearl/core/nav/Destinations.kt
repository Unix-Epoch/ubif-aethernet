package dev.aethernet.linkpearl.core.nav

import androidx.compose.ui.graphics.vector.ImageVector
import dev.aethernet.linkpearl.core.design.LpIcons

/** Route strings. Reserved deep links: `linkpearl://<route>` for every route below. Add sub-routes inside your own package's graph. */
object Routes {
    const val HOME = "home"
    const val ALERTS = "alerts"
    const val ALERT_SETTINGS = "alerts/settings"
    const val WORK_ORDERS = "workorders"
    const val WORK_ORDER = "workorders/{id}"
    const val SETTINGS = "settings"
    const val ONBOARDING = "onboarding"

    const val ARG_ID = "id"
    const val DEEP_LINK_SCHEME = "linkpearl"

    fun workOrder(id: String) = "workorders/$id"
    /** The id format Work orders opens: `<store>-<wo>`, e.g. `workorders/914-7000001`. */
    fun workOrder(store: Int, wo: Long) = workOrder("$store-$wo")
    fun deepLink(route: String) = "$DEEP_LINK_SCHEME://$route"
}

/** The four top-level destinations: bottom bar on compact width, navigation rail from 600dp. */
enum class TopLevel(val route: String, val label: String, val railLabel: String, val icon: ImageVector) {
    Home(Routes.HOME, "Home", "Home", LpIcons.Home),
    Alerts(Routes.ALERTS, "Alerts", "Alerts", LpIcons.Bell),
    WorkOrders(Routes.WORK_ORDERS, "Work orders", "Orders", LpIcons.Orders),
    Settings(Routes.SETTINGS, "Settings", "Settings", LpIcons.Sliders);

    companion object {
        /** The top-level destination that owns [route] (`alerts/settings` belongs to Alerts). */
        fun of(route: String?): TopLevel? = route?.let { r -> entries.firstOrNull { r == it.route || r.startsWith(it.route + "/") } }
    }
}
