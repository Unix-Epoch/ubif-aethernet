package dev.aethernet.linkpearl.feature.pullbacks

/** What the last scan said, shown under the current item. */
enum class PbMsg { Mismatch, Empty, Reverted }

/**
 * A scanning run, pure (the view model holds one and saves it). The same commands as scan_serials.py: a scan that matches the expected
 * serial (trimmed, case-insensitive) is done; a mismatch can be accepted anyway (OVERRIDE); Skip; Undo puts the previous item back.
 * Nothing is marked from the phone: the results file goes to Aethernet for that.
 */
data class PbSession(
    val file: String,
    val store: String,
    val list: PbList,
    val idx: Int? = list.items.indexOfFirst { it.status == PbStatus.Pending }.takeIf { it >= 0 },
    val history: List<Int> = emptyList(),
    val last: String? = null,
    val msg: PbMsg? = null,
    val lastOk: Boolean = false,
) {
    val items get() = list.items
    val current: PbItem? get() = idx?.let { items.getOrNull(it) }
    val total get() = items.size
    val pending get() = items.count { it.status == PbStatus.Pending }
    val done get() = items.count { it.done }
    val complete get() = idx == null

    fun nextPending(from: Int): Int? {
        val n = items.size
        for (o in 1..n) { val j = (from + o) % n; if (items[j].status == PbStatus.Pending) return j }
        return null
    }
    val next: PbItem? get() = idx?.let { i -> nextPending(i)?.takeIf { it != i }?.let { items[it] } }

    private fun with(i: Int, item: PbItem) = copy(list = list.copy(items = items.toMutableList().also { it[i] = item }))
    private fun advance(ok: Boolean): PbSession { val i = idx ?: return this; return copy(history = history + i, idx = nextPending(i), last = null, msg = null, lastOk = ok) }

    fun scan(raw: String, now: String = Pullbacks.stamp()): PbSession {
        val it = current ?: return this
        val v = raw.trim()
        if (v.isEmpty()) return copy(msg = PbMsg.Empty, lastOk = false)
        if (Pullbacks.norm(v) == Pullbacks.norm(it.serial))
            return with(idx!!, it.copy(status = PbStatus.Matched, scanned = v, match = "YES", scannedAt = now)).advance(true)
        return copy(last = v, msg = PbMsg.Mismatch, lastOk = false)
    }
    fun acceptAnyway(now: String = Pullbacks.stamp()): PbSession {
        val it = current ?: return this
        val v = last ?: return this
        return with(idx!!, it.copy(status = PbStatus.Overridden, scanned = v, match = "OVERRIDE", scannedAt = now)).advance(true)
    }
    fun skip(): PbSession { val it = current ?: return this; return with(idx!!, it.reset().copy(status = PbStatus.Skipped)).advance(false) }
    fun undo(): PbSession {
        val j = history.lastOrNull() ?: return this
        return with(j, items[j].reset()).copy(idx = j, history = history.dropLast(1), last = null, msg = PbMsg.Reverted, lastOk = false)
    }
    fun scanSkipped(): PbSession {
        val l = list.copy(items = items.map { if (it.status == PbStatus.Skipped) it.copy(status = PbStatus.Pending) else it })
        return copy(list = l, idx = l.items.indexOfFirst { it.status == PbStatus.Pending }.takeIf { it >= 0 }, history = emptyList(), msg = null, last = null)
    }
    fun count(s: PbStatus) = items.count { it.status == s }
}
