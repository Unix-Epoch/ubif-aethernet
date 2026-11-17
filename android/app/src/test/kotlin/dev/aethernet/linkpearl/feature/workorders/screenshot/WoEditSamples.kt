package dev.aethernet.linkpearl.feature.workorders.screenshot

import dev.aethernet.linkpearl.feature.workorders.FollowSheetUi
import dev.aethernet.linkpearl.feature.workorders.FollowUp
import dev.aethernet.linkpearl.feature.workorders.FollowUpsInfo
import dev.aethernet.linkpearl.feature.workorders.LaneFilter
import dev.aethernet.linkpearl.feature.workorders.LoadView
import dev.aethernet.linkpearl.feature.workorders.ManagedTag
import dev.aethernet.linkpearl.feature.workorders.SealedUi
import dev.aethernet.linkpearl.feature.workorders.TagsSheetUi
import dev.aethernet.linkpearl.feature.workorders.TimelineEntry
import dev.aethernet.linkpearl.feature.workorders.WoDetailResponse
import dev.aethernet.linkpearl.feature.workorders.WoDetailUi
import dev.aethernet.linkpearl.feature.workorders.WoKey
import dev.aethernet.linkpearl.feature.workorders.WoListUi
import dev.aethernet.linkpearl.feature.workorders.WoParts
import dev.aethernet.linkpearl.feature.workorders.WoRow
import dev.aethernet.linkpearl.feature.workorders.WoTag
import java.time.Instant
import java.time.LocalDate

/**
 * Fake data for Waymark from the phone (tag and follow-up sheets) and the Old filter, after the approved mock-ups (5-wo-detail-edit,
 * 5-tags-sheet, 5-follow-up-sheet, 9-aging). Invented work orders, the sandbox store; today is Fri, Nov 13 in the store.
 */
object WoEditSamples {
    private val NOW = WoSamples.NOW
    private fun ago(minutes: Long) = Instant.ofEpochMilli(NOW - minutes * 60_000).toString()

    val rush = WoTag("Rush", "red")
    val voicemail = WoTag("Left voicemail", null)

    private val editRow = WoRow(
        store = 999999, wo = 700000016, statusId = 13, status = "Ready for pickup", lane = "rfp", device = "iPhone 15 Pro", program = "Retail", bin = "C7",
        cartValue = 289.99, statusSince = ago(6 * 1440L + 200), createdAt = ago(9 * 1440L), tags = listOf(rush, voicemail), followUp = FollowUp("rfp", "2026-11-10"),
    )

    fun detail(tags: TagsSheetUi? = null, follow: FollowSheetUi? = null) = WoDetailUi(
        key = WoKey(999999, 700000016), view = LoadView.Ok, receivedAtMs = NOW, unlocked = false, sealed = SealedUi.Locked, stores = WoSamples.stores,
        tagsSheet = tags, followSheet = follow,
        detail = WoDetailResponse(
            now = Instant.ofEpochMilli(NOW).toString(), wo = editRow,
            timeline = listOf(
                TimelineEntry(13, "Ready for pickup", "rfp", ago(6 * 1440L + 200), null, 6 * 86400L + 12000, current = true),
                TimelineEntry(10, "Work started", "work", ago(6 * 1440L + 360), ago(6 * 1440L + 200), 9600),
            ),
            timelineSource = "periods", parts = WoParts(null), changes = emptyList(),
        ),
    )

    val today: LocalDate = LocalDate.parse("2026-11-13")

    val managed = listOf(
        ManagedTag("Rush", "red"), ManagedTag("Parts hold", "orange"), ManagedTag("Needs charger", "blue"), ManagedTag("Data backup", "teal"),
    )

    fun tagsSheet() = detail(tags = TagsSheetUi(loading = false, managed = managed))

    /** "+1 day" picked (today Nov 13, the due Nov 10: +1 is Sat, Nov 14). */
    fun followSheet() = detail(follow = FollowSheetUi(choice = LocalDate.parse("2026-11-14")))

    // ---- the Old filter ----
    private fun old(wo: Long, device: String, issue: String, program: String, statusId: Int, status: String, lane: String, minutes: Long) = WoRow(
        store = 999999, wo = wo, statusId = statusId, status = status, lane = lane, device = device, program = program, issues = listOf(issue),
        statusSince = ago(minutes), createdAt = ago(minutes + 2000), bin = "C7",
    )

    private val oldRows = listOf(
        old(700000016, "iPhone 15 Pro", "Screen", "Retail", 13, "Ready for pickup", "rfp", 9 * 1440L + 180),
        old(700000003, "Galaxy S23 Ultra", "Battery", "Retail", 4, "Awaiting callback", "wait", 8 * 1440L + 300),
        old(700000014, "Pixel 8", "Battery", "Out Of Warranty", 12, "Repair summary", "work", 5 * 1440L + 60),
        old(700000009, "Galaxy S24", "Charge port", "Retail", 9, "Diagnostics", "work", 3 * 1440L + 360),
    )

    fun oldList() = WoListUi(
        stores = WoSamples.stores, store = null, filter = LaneFilter.Old, view = LoadView.Ok, rows = oldRows, lanes = WoSamples.lanes,
        followUps = FollowUpsInfo(5, "2026-11-13"), old = 4, receivedAtMs = NOW, unlocked = true,
        names = mapOf(WoKey(999999, 700000016) to "Jordan Ellis", WoKey(999999, 700000003) to "Casey Hayes", WoKey(999999, 700000014) to "Riley Price", WoKey(999999, 700000009) to "Morgan Brooks"),
    )

    /** The open list behind the detail panel on the inner screen. */
    fun openList() = WoSamples.list(false).copy(old = 2, followUps = FollowUpsInfo(5, "2026-11-13"))
}
