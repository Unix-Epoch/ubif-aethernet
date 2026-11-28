package dev.aethernet.linkpearl.feature.morningcheck

/** Where a work order is in the check. */
enum class McMark { Pending, Checked, Changed, Failed, Skipped }

enum class McOrder(val label: String) { Location("By location"), Status("By status"), Oldest("Oldest first") }

/**
 * One work order in the check. [movedUp]: scanned ahead of its turn, so it was brought forward. [sending]: the id of the change
 * waiting for Portal's answer. [last]: the last change sent (for Try again). [failed]: Portal's message per field. [was]: the row
 * before this check changed it.
 */
data class McItem(
    val row: McRow,
    val mark: McMark = McMark.Pending,
    val movedUp: Boolean = false,
    val sending: String? = null,
    val last: McChange? = null,
    val failed: List<Pair<String, String>> = emptyList(),
    val was: McRow? = null,
)

/** A scan that found nothing to open. */
enum class McNote { NotOpen }

/**
 * A morning check, pure: the open work orders in walking order, the one in front of you ([idx]), and what happened to each.
 * Scanning a work order label brings that order forward to now (marked as moved up); Skip passes one by, and skipped ones can be
 * checked at the end. Nothing here talks to the browser; [MorningCheckViewModel] does.
 */
data class McSession(
    val run: String,
    val items: List<McItem>,
    val idx: Int?,
    val statuses: Map<Int, McStatus> = emptyMap(),
    val bins: Boolean = false,
    val note: McNote? = null,
    /** Notes per work order as the browser sent them; a work order missing here hasn't been asked yet (or is being asked). */
    val notes: Map<String, McNotes> = emptyMap(),
) {
    val current get() = idx?.let { items.getOrNull(it) }
    val total get() = items.size
    val done get() = items.count { it.mark != McMark.Pending && it.mark != McMark.Skipped }
    val complete get() = idx == null
    fun count(m: McMark) = items.count { it.mark == m }
    fun withNotes(n: McNotes) = copy(notes = notes + (n.wo to n))
    fun dropNotes(wo: String) = copy(notes = notes - wo)
    fun statusName(id: Int) = statuses[id]?.name?.takeIf { it.isNotBlank() } ?: "Status $id"

    private fun put(i: Int, f: (McItem) -> McItem) = copy(items = items.toMutableList().also { it[i] = f(it[i]) }, note = null)

    /** The next pending order after [from] (wrapping to the top), or null when none is left. */
    private fun nextFrom(from: Int, list: List<McItem> = items): Int? =
        ((from + 1 until list.size) + (0..from.coerceAtMost(list.size - 1))).firstOrNull { list[it].mark == McMark.Pending }

    fun looksRight(): McSession { val i = idx ?: return this; return put(i) { it.copy(mark = if (it.mark == McMark.Changed) McMark.Changed else McMark.Checked) }.advance() }
    fun skip(): McSession { val i = idx ?: return this; return put(i) { it.copy(mark = McMark.Skipped) }.advance() }
    fun advance(): McSession { val i = idx ?: return this; val s = copy(note = null); return s.copy(idx = s.nextFrom(i)) }

    /** Check the skipped ones: back to pending, from the first. */
    fun checkSkipped(): McSession {
        val list = items.map { if (it.mark == McMark.Skipped) it.copy(mark = McMark.Pending) else it }
        return copy(items = list, idx = list.indexOfFirst { it.mark == McMark.Pending }.takeIf { it >= 0 }, note = null)
    }

    /** A scanned work order label: that order comes to the front now. Not in the list → [McNote.NotOpen]. */
    fun scan(raw: String): McSession {
        val wo = raw.trim()
        val at = items.indexOfFirst { it.row.wo == wo }
        if (at < 0) return copy(note = McNote.NotOpen)
        val here = idx ?: return copy(idx = at, note = null) // after the end: open it where it is
        if (at == here) return copy(note = null)
        val list = items.toMutableList()
        val it = list.removeAt(at)
        val to = if (at < here) here - 1 else here
        // Ahead of its turn: moved up. Passed over earlier: back in front of you (a skipped one becomes pending again).
        list.add(to, it.copy(movedUp = at > here, mark = if (it.mark == McMark.Skipped) McMark.Pending else it.mark))
        return copy(items = list, idx = to, note = null)
    }

    /** A change set sent for the current order. */
    fun sending(cid: String, c: McChange): McSession { val i = idx ?: return this; return put(i) { it.copy(sending = cid, last = c, failed = emptyList()) } }

    /** Portal's answer for change [r.cid]: the order's new state, and Changed or Failed. */
    fun result(r: McResult): McSession {
        val i = items.indexOfFirst { it.sending == r.cid }.takeIf { it >= 0 } ?: return this
        return put(i) { item ->
            val row = r.after?.let { a -> item.row.copy(statusId = a.statusId, bin = a.bin, nickname = a.nickname, updatedAt = a.updatedAt) } ?: item.row
            val anySaved = r.ok || (item.last?.let { c -> listOfNotNull(c.status?.let { "status" }, c.bin?.let { "bin" }, c.nickname?.let { "nickname" }, c.note?.takeIf { n -> n.isNotBlank() }?.let { "note" }) }.orEmpty()
                .any { f -> r.failed.none { it.first == f || it.first == "wo" } })
            item.copy(row = row, was = item.was ?: item.row.takeIf { anySaved }, sending = null, failed = r.failed,
                mark = if (r.ok) McMark.Changed else McMark.Failed)
        }
    }

    companion object {
        private val natural = Comparator<String> { a, b ->
            val ra = Regex("""\d+|\D+""").findAll(a.lowercase()).map { it.value }.toList()
            val rb = Regex("""\d+|\D+""").findAll(b.lowercase()).map { it.value }.toList()
            for (k in 0 until minOf(ra.size, rb.size)) {
                val x = ra[k]; val y = rb[k]
                val c = if (x[0].isDigit() && y[0].isDigit()) x.toBigInteger().compareTo(y.toBigInteger()) else x.compareTo(y)
                if (c != 0) return@Comparator c
            }
            ra.size - rb.size
        }
        private fun woNum(r: McRow) = r.wo.toLongOrNull() ?: Long.MAX_VALUE

        /** Walking order: by location (no location last), by status (Portal's order), or oldest work order first. */
        fun sort(rows: List<McRow>, order: McOrder, statuses: Map<Int, McStatus> = emptyMap()): List<McRow> {
            val statusRank = statuses.keys.withIndex().associate { (i, id) -> id to i }
            val byBin = compareBy<McRow> { it.bin.isBlank() }.then(Comparator { a, b -> natural.compare(a.bin.trim(), b.bin.trim()) })
            return when (order) {
                McOrder.Location -> rows.sortedWith(byBin.thenBy { woNum(it) })
                McOrder.Status -> rows.sortedWith(compareBy<McRow> { statusRank[it.statusId] ?: Int.MAX_VALUE }.then(byBin).thenBy { woNum(it) })
                McOrder.Oldest -> rows.sortedBy { woNum(it) }
            }
        }

        fun of(list: McList, order: McOrder): McSession {
            val rows = sort(list.rows, order, list.statuses)
            return McSession(list.run, rows.map { McItem(it) }, if (rows.isEmpty()) null else 0, list.statuses, list.bins)
        }

        /** Bins in use, most used first: the quick picks in Edit. */
        fun bins(items: List<McItem>, limit: Int = 8): List<String> =
            items.map { it.row.bin.trim() }.filter { it.isNotEmpty() }.groupingBy { it }.eachCount().entries
                .sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenComparator { a, b -> natural.compare(a.key, b.key) }).take(limit).map { it.key }
    }
}
