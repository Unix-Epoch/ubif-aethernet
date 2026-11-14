package dev.aethernet.linkpearl.feature.workorders.screenshot

import dev.aethernet.linkpearl.feature.workorders.Cart
import dev.aethernet.linkpearl.feature.workorders.CartLine
import dev.aethernet.linkpearl.feature.workorders.FollowUp
import dev.aethernet.linkpearl.feature.workorders.FollowUpsInfo
import dev.aethernet.linkpearl.feature.workorders.LaneFilter
import dev.aethernet.linkpearl.feature.workorders.LoadView
import dev.aethernet.linkpearl.feature.workorders.Note
import dev.aethernet.linkpearl.feature.workorders.NoteKind
import dev.aethernet.linkpearl.feature.workorders.SealedUi
import dev.aethernet.linkpearl.feature.workorders.TimelineEntry
import dev.aethernet.linkpearl.feature.workorders.Unsealed
import dev.aethernet.linkpearl.feature.workorders.WoChange
import dev.aethernet.linkpearl.feature.workorders.WoDetailResponse
import dev.aethernet.linkpearl.feature.workorders.WoDetailUi
import dev.aethernet.linkpearl.feature.workorders.WoKey
import dev.aethernet.linkpearl.feature.workorders.WoListUi
import dev.aethernet.linkpearl.feature.workorders.WoPartRow
import dev.aethernet.linkpearl.feature.workorders.WoParts
import dev.aethernet.linkpearl.feature.workorders.WoRow
import dev.aethernet.linkpearl.feature.workorders.WoSort
import dev.aethernet.linkpearl.feature.workorders.WoTag
import java.time.Instant

/**
 * Fake data for the closed work orders and Auto-Waymark screens (work orders 7000000xx, the sandbox and Lynnhaven stores, made-up parts
 * and labels), in the shapes of MOBILE-API-wo.md. Times are the store's EST (UTC-5) written as UTC.
 */
object WoWaymarkSamples {
    private val NOW = WoSamples.NOW
    private fun ago(minutes: Long) = Instant.ofEpochMilli(NOW - minutes * 60_000).toString()
    private val stores = WoSamples.stores

    val partsHold = WoTag("Parts hold", "orange")
    val rush = WoTag("Rush", "red")
    val testTag = WoTag("Test tag", "#4a68f9")
    val oneOff = WoTag("Left voicemail", null)

    // ---- closed ----
    private fun closed(wo: Long, device: String, program: String, closedAt: String, outcome: String?, status: String, sold: Double?, store: Int = 999999) = WoRow(
        store = store, wo = wo, open = false, status = status, device = device, program = program, outcome = outcome, closedAt = closedAt,
        closedReason = status, lastCartValue = sold, createdAt = "2026-11-06T15:00:00Z",
    )

    private val closedRows = listOf(
        closed(700000009, "Galaxy S22", "Retail", "2026-11-11T20:42:00Z", "Completed", "Sale complete", 189.98),
        closed(700000011, "iPhone 14", "Asurion", "2026-11-11T16:05:00Z", "Incomplete", "Sale complete", 99.00),
        closed(700000004, "Pixel 8", "Retail", "2026-11-10T22:20:00Z", "Declined", "Closed", null),
        closed(700000005, "Galaxy S23 Ultra", "Out Of Warranty", "2026-11-10T18:12:00Z", null, "Cancelled", null),
        closed(700000012, "iPhone 15 Pro", "Retail", "2026-11-09T21:50:00Z", "No issue found", "Closed", 29.99, store = 326),
    )
    private val closedNames = mapOf(
        WoKey(999999, 700000009) to "Casey Hayes", WoKey(999999, 700000011) to "Riley Price", WoKey(999999, 700000004) to "Morgan Brooks",
        WoKey(999999, 700000005) to "Jordan Ellis", WoKey(326, 700000012) to "Casey Reyes",
    )

    fun closedList(unlocked: Boolean = true) = WoListUi(
        stores = stores, store = null, filter = LaneFilter.Closed, sort = WoSort.Closed, view = LoadView.Ok, rows = closedRows, lanes = WoSamples.lanes,
        followUps = FollowUpsInfo(5, "2026-11-13"), hasMore = true, receivedAtMs = NOW, unlocked = unlocked, names = if (unlocked) closedNames else emptyMap(),
    )

    private val unsealedClosed = Unsealed(
        "Casey Hayes", listOf("7575550142"), listOf("casey.hayes@example.com"), "356938035644821", null,
        listOf(
            Note("Customer picked up. Screen replaced, back glass untouched.", "2026-11-11T20:40:00Z", NoteKind.Manual, null, null),
            Note("Customer approved the screen price.", "2026-11-09T16:30:00Z", NoteKind.Manual, null, null),
        ), 2, ago(2), hasSnapshot = true,
    )

    fun closedDetail(parts: WoParts? = closedParts, changes: List<WoChange> = closedChanges) = WoDetailUi(
        key = WoKey(999999, 700000009), view = LoadView.Ok, receivedAtMs = NOW, unlocked = true, sealed = SealedUi.Shown(unsealedClosed), stores = stores,
        detail = WoDetailResponse(
            now = Instant.ofEpochMilli(NOW).toString(),
            wo = closedRows[0].copy(statusId = 14, bin = "C7", createdAt = "2026-11-09T14:15:00Z"),
            timeline = listOf(
                TimelineEntry(13, "Ready for pickup", "rfp", "2026-11-10T19:10:00Z", "2026-11-11T20:42:00Z", 91920),
                TimelineEntry(11, "Quality check", "work", "2026-11-10T18:40:00Z", "2026-11-10T19:10:00Z", 1800),
                TimelineEntry(10, "Work in progress", "work", "2026-11-09T16:20:00Z", "2026-11-10T18:40:00Z", 94800),
                TimelineEntry(9, "Diagnostics", "work", "2026-11-09T15:05:00Z", "2026-11-09T16:20:00Z", 4500),
                TimelineEntry(8, "Ready for work", "start", "2026-11-09T14:40:00Z", "2026-11-09T15:05:00Z", 1500),
            ),
            timelineSource = "periods", cart = null, parts = parts, changes = changes,
        ),
    )

    val closedParts = WoParts("done", listOf(
        WoPartRow("L1", "900203-0000000041", "900203", "900203", "Sample screen assembly, Galaxy S22", 1.0, 159.99, "Sold"),
        WoPartRow("L2", "900207-0000000117", "900207", "900207", "Sample screen protector", 2.0, 4.99, "Sold"),
        WoPartRow("L3", null, "900209", "900209", "Sample adhesive kit", 1.0, 20.01, "Sold"),
    ))
    val closedChanges = listOf(
        WoChange("2026-11-11T20:42:00Z", "status", "Ready for pickup", "Sale complete"),
        WoChange("2026-11-10T19:10:00Z", "status", "Quality check", "Ready for pickup"),
        WoChange("2026-11-10T18:40:00Z", "status", "Work in progress", "Quality check"),
        WoChange("2026-11-10T17:00:00Z", "nextUpdate", "2026-11-10T19:00:00Z", "2026-11-11T19:00:00Z"),
        WoChange("2026-11-09T16:20:00Z", "status", "Diagnostics", "Work in progress"),
        WoChange("2026-11-09T14:15:00Z", "status", null, "Ready for work"),
    )

    // ---- Auto-Waymark ----
    private fun open(wo: Long, device: String, program: String, status: String, lane: String, minutes: Long, store: Int = 999999, cart: Double? = null,
                     tags: List<WoTag> = emptyList(), follow: FollowUp? = null) = WoRow(
        store = store, wo = wo, device = device, program = program, status = status, lane = lane, statusSince = ago(minutes), cartValue = cart,
        createdAt = ago(minutes + 3000), bin = "C7", tags = tags, followUp = follow,
    )

    private val followRows = listOf(
        open(700000016, "iPhone 15 Pro", "Retail", "Ready for pickup", "rfp", 6 * 1440L + 200, cart = 289.99, tags = listOf(rush, oneOff), follow = FollowUp("rfp", "2026-11-10")),
        open(700000003, "Galaxy S23 Ultra", "Retail", "Awaiting callback", "wait", 4 * 1440L + 240, tags = listOf(partsHold), follow = FollowUp("callback", "2026-11-12")),
        open(700000020, "Galaxy S24", "Out Of Warranty", "Ready for pickup", "rfp", 4 * 1440L + 60, store = 326, cart = 149.99, tags = listOf(testTag), follow = FollowUp("rfp", "2026-11-12")),
        open(700000021, "Pixel 8", "Retail", "Ready for pickup", "rfp", 3 * 1440L + 30, tags = listOf(rush, testTag), follow = FollowUp("rfp", "2026-11-13")),
        open(700000022, "iPhone 14", "Asurion", "Awaiting device", "wait", 1440L + 600, follow = FollowUp("callback", "2026-11-13")),
    )
    private val followNames = mapOf(
        WoKey(999999, 700000016) to "Jordan Ellis", WoKey(999999, 700000003) to "Casey Hayes", WoKey(326, 700000020) to "Riley Price",
        WoKey(999999, 700000021) to "Morgan Brooks", WoKey(999999, 700000022) to "Casey Reyes",
    )

    fun followList(unlocked: Boolean = true) = WoListUi(
        stores = stores, store = null, filter = LaneFilter.FollowUps, view = LoadView.Ok, rows = followRows, lanes = WoSamples.lanes,
        followUps = FollowUpsInfo(5, "2026-11-13"), receivedAtMs = NOW, unlocked = unlocked, names = if (unlocked) followNames else emptyMap(),
    )

    private val unsealedFollow = Unsealed(
        "Jordan Ellis", listOf("7575550177"), listOf("jordan.ellis@example.com"), "356938035699912", null,
        listOf(
            Note("Screen replaced and tested. Customer asked for a text when ready.", ago(6 * 1440L + 200), NoteKind.Manual, null, null),
            Note("Status changed to Ready for pickup.", ago(6 * 1440L + 200), NoteKind.Automatic, null, null),
        ), 2, ago(2), hasSnapshot = true,
    )

    fun followDetail() = WoDetailUi(
        key = WoKey(999999, 700000016), view = LoadView.Ok, receivedAtMs = NOW, unlocked = true, sealed = SealedUi.Shown(unsealedFollow), stores = stores,
        detail = WoDetailResponse(
            now = Instant.ofEpochMilli(NOW).toString(), wo = followRows[0],
            timeline = listOf(
                TimelineEntry(13, "Ready for pickup", "rfp", ago(6 * 1440L + 200), null, 6 * 86400L + 12000, current = true),
                TimelineEntry(11, "Quality check", "work", ago(6 * 1440L + 260), ago(6 * 1440L + 200), 3600),
                TimelineEntry(10, "Work in progress", "work", ago(7 * 1440L + 400), ago(6 * 1440L + 260), 82800),
            ),
            timelineSource = "periods",
            cart = Cart(value = 289.99, total = 289.99, paid = 0.0, due = 289.99, lines = listOf(
                CartLine("Screen", "1001", 1.0, 249.99, 249.99, "Reserved"), CartLine("Labor", "9", 1.0, 40.0, 40.0, null),
            )),
            parts = WoParts(null), changes = emptyList(),
        ),
    )
}
