package dev.aethernet.linkpearl.feature.pullbacks

/** What the last scan said, shown under the current item. */
enum class PbMsg { Mismatch, Empty, Reverted }

/**
 * A scanning run, pure (the view model holds one and saves it). The same commands as scan_serials.py: a scan that matches the expected
 * serial (trimmed, case-insensitive) is done; a mismatch can be accepted anyway (OVERRIDE); Skip; Undo puts the previous item back.
 * Nothing is marked from the phone itself: the results file goes to Aethernet for that, or, on a run joined from Aethernet over Linkshell
 * ([link] = the browser's run id), each scan goes to the browser, which marks it in Portal and answers ([pcResult]). The answer is kept
 * in the item's Backend Status: [SENDING] until it comes, then queued (kept there until Pullbacks is open), success,
 * skipped-already-marked or failed, as in the results file.
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
    val link: String? = null,
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

    /** Items scanned here whose answer from the browser hasn't come yet. */
    val sending get() = items.count { it.backendStatus == SENDING || it.backendStatus == QUEUED }

    /** The browser's answer for item [i]; it wins over what the phone thought, except over a scan still on its way. */
    fun pcResult(i: Int, state: PcState, message: String? = null, now: String = Pullbacks.stamp()): PbSession {
        val it = items.getOrNull(i) ?: return this
        fun done() = if (it.done) it else it.copy(status = PbStatus.Matched, scanned = it.serial, match = "YES", scannedAt = now)
        val next = when (state) {
            PcState.Pending -> if (it.backendStatus == SENDING || it.status == PbStatus.Pending) return this else it.reset()
            PcState.Skipped -> if (it.status == PbStatus.Skipped) return this else it.reset().copy(status = PbStatus.Skipped)
            PcState.Queued -> done().copy(backendStatus = QUEUED)
            PcState.Marked -> done().copy(backendStatus = "success", backendMessage = message.orEmpty(), backendAt = now)
            PcState.Already -> done().copy(backendStatus = "skipped-already-marked", backendMessage = message.orEmpty(), backendAt = now)
            PcState.Failed -> done().copy(backendStatus = "failed", backendMessage = message.orEmpty(), backendAt = now)
        }
        val s = with(i, next)
        val at = s.idx
        val idx = when {
            at != null && s.items[at].status == PbStatus.Pending -> at
            at != null -> s.nextPending(at)
            else -> s.items.indexOfFirst { x -> x.status == PbStatus.Pending }.takeIf { x -> x >= 0 }
        }
        return s.copy(idx = idx, history = if (next.status == PbStatus.Pending) s.history - i else s.history)
    }

    /** Marks item [i] as sent to the browser. */
    fun sent(i: Int): PbSession = items.getOrNull(i)?.let { with(i, it.copy(backendStatus = SENDING)) } ?: this

    /** The browser's whole list again (after a rejoin): every item takes its state from it. */
    fun reconcile(run: PcRun): PbSession = run.items.fold(this) { s, x -> if (x.i in s.items.indices) s.pcResult(x.i, x.state) else s }

    companion object {
        const val SENDING = "sending"
        const val QUEUED = "queued"

        /** A run joined from Aethernet. */
        fun fromRun(run: PcRun): PbSession {
            val items = run.items.map { PbItem(store = run.store, sku = it.sku, description = it.description, serial = it.serial) }
            val s = PbSession(run.file.ifBlank { "Pullback Serials.xlsx" }, run.store, PbList(listOf("Store", "SKU", "Description", "Serial"), items), link = run.run)
            return s.reconcile(run).copy(history = emptyList())
        }
    }
}
