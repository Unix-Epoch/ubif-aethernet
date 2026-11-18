package dev.aethernet.linkpearl.feature.scan

import com.google.mlkit.vision.barcode.common.Barcode

/** The general scanner reads Code 128 only: work order labels (the WO number) and serial labels (`SKU-Serial`). */
val SCAN_FORMATS = listOf(Barcode.FORMAT_CODE_128)

/** What a scanned code opens. */
sealed interface ScanTarget {
    /** A work order label: the bare Portal work order number. */
    data class WorkOrder(val number: String) : ScanTarget
    /** A serial label (`SKU-Serial`, or a buyback's `B-…`), as Retrace stores it. */
    data class Label(val label: String) : ScanTarget
}

object ScanCode {
    private val wo = Regex("""^\d{5,12}$""")
    /** The tracker's label shape (tracker-worker/src/retrace.js `LABEL_RE`). */
    private val label = Regex("""^(B-)?([A-Za-z0-9]{2,20})-(\d{4,14})$""", RegexOption.IGNORE_CASE)

    /** The work order or label in [raw], else null. */
    fun parse(raw: String?): ScanTarget? {
        val s = raw?.trim().orEmpty()
        if (wo.matches(s)) return ScanTarget.WorkOrder(s)
        val m = label.matchEntire(s) ?: return null
        return ScanTarget.Label((if (m.groupValues[1].isNotEmpty()) "B-" else "") + m.groupValues[2] + "-" + m.groupValues[3])
    }

    /** The stores to look a label up in: [preferred] first (when it is one of [stores]), then the rest in order. */
    fun storeOrder(preferred: Int?, stores: List<Int>): List<Int> =
        (listOfNotNull(preferred?.takeIf { it in stores }) + stores).distinct()
}
