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
    const val RETRACE = "retrace"
    const val RETRACE_ITEM = "retrace/item/{store}/{item}"
    const val RETRACE_LABEL = "retrace/label/{store}/{label}"
    const val SETTINGS = "settings"
    const val ONBOARDING = "onboarding"

    const val ARG_ID = "id"
    const val ARG_STORE = "store"
    const val ARG_ITEM = "item"
    const val ARG_LABEL = "label"
    const val DEEP_LINK_SCHEME = "linkpearl"

    fun workOrder(id: String) = "workorders/$id"
    /** The id format Work orders opens: `<store>-<wo>`, e.g. `workorders/914-7000001`. */
    fun workOrder(store: Int, wo: Long) = workOrder("$store-$wo")
    private fun pathEnc(s: String) = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
    fun retraceItem(store: Int, item: String) = "retrace/item/$store/${pathEnc(item)}"
    fun retraceLabel(store: Int, label: String) = "retrace/label/$store/${pathEnc(label)}"
    fun deepLink(route: String) = "$DEEP_LINK_SCHEME://$route"
}

/** The five top-level destinations: bottom bar. */
enum class TopLevel(val route: String, val label: String, val icon: ImageVector) {
    Home(Routes.HOME, "Home", LpIcons.Home),
    Alerts(Routes.ALERTS, "Alerts", LpIcons.Bell),
    WorkOrders(Routes.WORK_ORDERS, "Work orders", LpIcons.Orders),
    Retrace(Routes.RETRACE, "Retrace", LpIcons.Retrace),
    Settings(Routes.SETTINGS, "Settings", LpIcons.Sliders);

    companion object {
        /** The top-level destination that owns [route] (`alerts/settings` belongs to Alerts). */
        fun of(route: String?): TopLevel? = route?.let { r -> entries.firstOrNull { r == it.route || r.startsWith(it.route + "/") } }
    }
}
