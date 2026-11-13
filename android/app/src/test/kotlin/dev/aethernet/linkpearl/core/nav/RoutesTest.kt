package dev.aethernet.linkpearl.core.nav

import dev.aethernet.linkpearl.feature.workorders.WoKey
import org.junit.Assert.assertEquals
import org.junit.Test

class RoutesTest {
    @Test fun workOrderRouteIsTheIdWorkOrdersOpens() {
        assertEquals("workorders/914-7000001", Routes.workOrder(914, 7000001))
        assertEquals("linkpearl://workorders/914-7000001", Routes.deepLink(Routes.workOrder(914, 7000001)))
        assertEquals(WoKey(914, 7000001), WoKey.parse("914-7000001"))
    }

    @Test fun alertSettingsBelongToAlertsInTheBar() {
        assertEquals(TopLevel.Alerts, TopLevel.of(Routes.ALERT_SETTINGS))
        assertEquals(TopLevel.WorkOrders, TopLevel.of(Routes.workOrder(914, 1)))
    }
}
