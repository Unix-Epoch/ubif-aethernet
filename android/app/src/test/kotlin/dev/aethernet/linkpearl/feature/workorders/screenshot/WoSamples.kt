package dev.aethernet.linkpearl.feature.workorders.screenshot

import dev.aethernet.linkpearl.core.data.StoreRef
import dev.aethernet.linkpearl.feature.workorders.Card
import dev.aethernet.linkpearl.feature.workorders.Cart
import dev.aethernet.linkpearl.feature.workorders.CartLine
import dev.aethernet.linkpearl.feature.workorders.LoadView
import dev.aethernet.linkpearl.feature.workorders.Note
import dev.aethernet.linkpearl.feature.workorders.NoteKind
import dev.aethernet.linkpearl.feature.workorders.SealedUi
import dev.aethernet.linkpearl.feature.workorders.TimelineEntry
import dev.aethernet.linkpearl.feature.workorders.Unsealed
import dev.aethernet.linkpearl.feature.workorders.WoDetailResponse
import dev.aethernet.linkpearl.feature.workorders.WoDetailUi
import dev.aethernet.linkpearl.feature.workorders.WoKey
import dev.aethernet.linkpearl.feature.workorders.WoLanes
import dev.aethernet.linkpearl.feature.workorders.WoListUi
import dev.aethernet.linkpearl.feature.workorders.WoRow
import java.time.Instant

/** Invented display data in the shape of the real responses (the mockups' numbers, minus what the server cannot provide). */
object WoSamples {
    val NOW: Long = Instant.parse("2026-11-13T21:14:00Z").toEpochMilli() // 4:14 PM in the store's zone
    private fun ago(minutes: Long) = Instant.ofEpochMilli(NOW - minutes * 60_000).toString()

    val stores = listOf(StoreRef(999999, "Sandbox"), StoreRef(326, "Lynnhaven"))

    private fun row(wo: Long, device: String, program: String, status: String, lane: String, minutes: Long, store: Int = 999999, cart: Double? = null) =
        WoRow(store = store, wo = wo, device = device, program = program, status = status, lane = lane, statusSince = ago(minutes), cartValue = cart,
            createdAt = ago(minutes + 3000), bin = "C7")

    val rows = listOf(
        row(700000014, "Galaxy S24", "Out Of Warranty", "Repair in progress", "work", 5 * 1440L, cart = 289.99),
        row(700000003, "Galaxy S23 Ultra", "Retail", "Awaiting item", "wait", 4 * 1440L + 240),
        row(700000001, "Galaxy S23 Ultra", "Retail", "Need to order", "order", 2 * 1440L + 120),
        row(700000007, "iPhone 14", "Asurion", "Ready for work", "start", 2 * 1440L + 1320, store = 326),
        row(700000016, "iPhone 15 Pro", "Retail", "Ready for pickup", "rfp", 1440L + 360),
    )
    val names = mapOf(
        WoKey(999999, 700000014) to "Riley Price", WoKey(999999, 700000003) to "Casey Hayes", WoKey(999999, 700000001) to "Morgan Brooks",
        WoKey(326, 700000007) to "Casey Reyes", WoKey(999999, 700000016) to "Jordan Ellis",
    )
    val lanes = WoLanes(order = 2, start = 3, work = 6, wait = 5, rfp = 4, total = 20)

    fun list(unlocked: Boolean) = WoListUi(
        stores = stores, store = null, view = LoadView.Ok, rows = rows, lanes = lanes, hasMore = true,
        receivedAtMs = NOW, unlocked = unlocked, names = if (unlocked) names else emptyMap(),
    )

    val detailResponse = WoDetailResponse(
        now = Instant.ofEpochMilli(NOW).toString(),
        wo = rows[0],
        timeline = listOf(
            TimelineEntry(10, "Repair in progress", "work", ago(5 * 1440L), null, 5 * 86400L, current = true),
            TimelineEntry(9, "Diagnostics", "work", ago(5 * 1440L + 28 * 60), ago(5 * 1440L), 28 * 3600L),
            TimelineEntry(8, "Ready for work", "start", ago(5 * 1440L + 46 * 60), ago(5 * 1440L + 28 * 60), 18 * 3600L),
        ),
        timelineSource = "periods",
        cart = Cart(value = 289.99, total = 289.99, paid = 0.0, due = 289.99, lines = listOf(
            CartLine("Screen", "1001", 1.0, 249.99, 249.99, "Reserved"), CartLine("Labor", "9", 1.0, 40.0, 40.0, null),
        )),
    )

    val unsealed = Unsealed.from(
        Card("Riley Price", listOf("7575550142"), listOf("riley.price@example.com"), "356938035644821", null, null),
        null, ago(2),
    ).let {
        Unsealed(it.name, it.phones, it.emails, it.imei, it.serial, listOf(
            Note("Customer approved the screen price. Waiting on the part to arrive.", ago(3 * 1440L + 120), NoteKind.Manual, null, "Casey R."),
            Note("Jordan C. started Repair in progress.", ago(5 * 1440L), NoteKind.Automatic, null, "Jordan C."),
            Note("Dropped, cracked screen. Back glass is fine.", ago(5 * 1440L + 46 * 60), NoteKind.Manual, "initial_checkin", "Jordan C."),
        ), 3, ago(2), hasSnapshot = true)
    }

    fun detail(sealed: SealedUi, unlocked: Boolean) = WoDetailUi(
        key = WoKey(999999, 700000014), view = LoadView.Ok, detail = detailResponse, receivedAtMs = NOW, unlocked = unlocked, sealed = sealed, stores = stores,
    )
}
