package dev.aethernet.linkpearl.feature.retrace.screenshot

import dev.aethernet.linkpearl.feature.retrace.RetraceUi
import dev.aethernet.linkpearl.feature.retrace.RetraceView
import dev.aethernet.linkpearl.feature.retrace.RtCount
import dev.aethernet.linkpearl.feature.retrace.RtDetailUi
import dev.aethernet.linkpearl.feature.retrace.RtItemLabel
import dev.aethernet.linkpearl.feature.retrace.RtItemInfo
import dev.aethernet.linkpearl.feature.retrace.RtItemResponse
import dev.aethernet.linkpearl.feature.retrace.RtItemRow
import dev.aethernet.linkpearl.feature.retrace.RtLabelHit
import dev.aethernet.linkpearl.feature.retrace.RtLabelResponse
import dev.aethernet.linkpearl.feature.retrace.RtLabelRow
import dev.aethernet.linkpearl.feature.retrace.RtMovement
import dev.aethernet.linkpearl.feature.retrace.RtPoRow
import dev.aethernet.linkpearl.feature.workorders.LoadView
import dev.aethernet.linkpearl.feature.workorders.Problem
import dev.aethernet.linkpearl.feature.workorders.screenshot.WoSamples

/** Fake Retrace data in the API's shapes: made-up items, labels (<item>-<digits>), purchase orders and times (EST written as UTC). */
object RetraceSamples {
    val items = listOf(
        RtItemRow("900101", "Sample screen assembly, Galaxy S24", "Screens", 7, 9, "2026-11-13T18:48:00Z"),
        RtItemRow("900102", "Sample battery, iPhone 14", "Batteries", 12, 12, "2026-11-13T16:20:00Z"),
        RtItemRow("900103", "Sample charge port, Pixel 8", null, 0, 2, "2026-11-12T21:05:00Z"),
        RtItemRow("900104", "Sample back glass, iPhone 15 Pro", null, 3, 4, "2026-11-12T15:30:00Z"),
        RtItemRow("900105", "Sample screen protector, universal", null, 48, 52, "2026-11-11T22:12:00Z"),
        RtItemRow("900106", "Sample SIM tray, Galaxy S23", null, null, null, "2026-11-09T14:45:00Z"),
    )

    val pos = listOf(
        RtPoRow("9900104", "Backorder", "Sample Parts Vendor", "2026-11-12T05:00:00Z", labels = 8, received = 3, total = 1240.5),
        RtPoRow("9900107", "Backorder", "Sample Parts Vendor", "2026-11-12T05:00:00Z", labels = 12, received = 0, total = 860.0),
        RtPoRow("9900109", "Draft", "Lynnhaven #326", "2026-11-11T05:00:00Z", labels = null, received = null, total = null),
        RtPoRow("9900111", "Received", "Sample Accessories Co", "2026-11-10T05:00:00Z", labels = 50, received = 50, total = 312.4),
        RtPoRow("9900113", "Backorder", "Sample Parts Vendor", "2026-11-09T05:00:00Z", labels = 6, received = 0, total = 540.0),
    )

    fun home(view: RetraceView = RetraceView.Items, query: String = "", load: LoadView = LoadView.Ok, problem: Problem? = null) = RetraceUi(
        stores = WoSamples.stores, store = 999999, view = view, query = query, load = load, problem = problem, asOf = "2026-11-13T21:02:00Z", receivedAtMs = WoSamples.NOW,
        items = if (view == RetraceView.Items && load == LoadView.Ok) items else emptyList(), pos = if (view == RetraceView.PurchaseOrders && load == LoadView.Ok) pos else emptyList(),
    )

    fun labelJump() = home(query = "900101-00004").copy(
        items = emptyList(),
        labels = listOf(
            RtLabelHit("900101-0000000409", "900101", "Sample screen assembly, Galaxy S24", "Reserved", "wo"),
            RtLabelHit("900101-0000000413", "900101", "Sample screen assembly, Galaxy S24", "Available", "in"),
            RtLabelHit("900101-0000000414", "900101", "Sample screen assembly, Galaxy S24", "Available", "in"),
        ),
    )

    fun noMatch() = home(query = "zzz").copy(items = emptyList())

    private fun mv(at: String, kind: String, type: String? = null, id: String? = null, label: String? = null) = RtMovement(at, kind, type, id, label)

    val item = RtItemResponse(
        item = "900101", store = 999999, info = RtItemInfo("Sample screen assembly, Galaxy S24", "Screens", 9, 7, "2026-11-13T21:02:00Z"),
        counts = listOf(RtCount("Available", "in", 7), RtCount("Reserved", "wo", 2), RtCount("Sold", "out", 29), RtCount("Used on repair", "out", 2), RtCount("Defective", "q", 1)),
        labels = listOf(
            RtItemLabel("900101-0000000414", "Available", "in", null, "9900104", "received", "2026-11-13T18:48:00Z"),
            RtItemLabel("900101-0000000410", "Reserved", "wo", "700000019", null, "reserved", "2026-11-12T20:20:00Z"),
            RtItemLabel("900101-0000000409", "Reserved", "wo", "700000014", "9900101", "reserved", "2026-11-10T14:12:00Z"),
            RtItemLabel("900101-0000000413", "Available", "in", null, "9900101", "received", "2026-11-04T19:05:00Z"),
            RtItemLabel("900101-0000000388", "Sold", "out", "700000006", null, "sold", "2026-11-09T21:30:00Z"),
            RtItemLabel("900101-0000000391", "Used on repair", "out", "700000002", null, "used", "2026-11-08T19:15:00Z"),
            RtItemLabel("900101-0000000377", "Defective", "q", null, null, "defective", "2026-11-08T15:40:00Z"),
        ),
        labelsTotal = 41,
        movements = listOf(
            mv("2026-11-13T18:48:00Z", "received", "po", "9900104", "900101-0000000414"),
            mv("2026-11-12T20:20:00Z", "reserved", "wo", "700000019", "900101-0000000410"),
            mv("2026-11-10T14:12:00Z", "reserved", "wo", "700000014", "900101-0000000409"),
            mv("2026-11-09T21:30:00Z", "sold", "wo", "700000006", "900101-0000000388"),
            mv("2026-11-08T19:15:00Z", "used", "wo", "700000002"),
            mv("2026-11-08T15:40:00Z", "defective", label = "900101-0000000377"),
            mv("2026-11-04T19:05:00Z", "received", "po", "9900101", "900101-0000000413"),
        ),
    )
    fun itemUi() = RtDetailUi(stores = WoSamples.stores, view = LoadView.Ok, data = item)
    fun itemError(p: Problem) = RtDetailUi<RtItemResponse>(stores = WoSamples.stores, view = LoadView.Error, problem = p)

    val label = RtLabelResponse(
        label = "900101-0000000409", store = 999999,
        row = RtLabelRow("900101-0000000409", "900101", "Sample screen assembly, Galaxy S24", "Reserved", "wo", "700000014", "9900101", "FSO000012345"),
        movements = listOf(
            mv("2026-11-01T23:40:00Z", "shipped_to_store", "po", "9900101", "900101-0000000409"),
            mv("2026-11-04T19:05:00Z", "received", "po", "9900101", "900101-0000000409"),
            mv("2026-11-07T16:02:00Z", "reserved", "wo", "700000006", "900101-0000000409"),
            mv("2026-11-09T21:30:00Z", "unreserved", "wo", "700000006", "900101-0000000409"),
            mv("2026-11-10T14:12:00Z", "reserved", "wo", "700000014", "900101-0000000409"),
        ),
        movementsTotal = 5,
    )
    fun labelUi() = RtDetailUi(stores = WoSamples.stores, view = LoadView.Ok, data = label)
}
