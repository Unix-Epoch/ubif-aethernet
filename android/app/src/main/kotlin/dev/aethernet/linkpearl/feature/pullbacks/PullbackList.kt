package dev.aethernet.linkpearl.feature.pullbacks

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

/**
 * The pullback list, the same rules as Aethernet's Elusive Jump (src/66-pullbacks.js) and the scan_serials.py tool it replaces.
 *
 * Input: the PowerBI "Pullback Serials" export (.xlsx or .csv): Store, SKU, Description, Serial, Return Units, Return Value,
 * Consignment Status (Monty Flag when present). The header row is the first of the first 15 with a Serial column (`'Unique Serials'[Serial]`
 * counts), rows without a serial are dropped (Total, "Applied filters"), HTML entities are decoded, items are put in scan order ([scanOrder]).
 * Output: the script's "Scan Results" sheet: the input columns + Scanned Serial, Match, Status, Scanned At, Backend Status, Backend Message,
 * Backend At, rows filled green (matched), red (mismatch), yellow (overridden, skipped, already marked).
 *
 * The phone can't reach Portal, so Backend Status stays blank here: uploading the results file on Aethernet's Pullbacks page marks every
 * scanned item in Portal.
 */
object Pullbacks {
    val RESULT_HEADERS = listOf("Scanned Serial", "Match", "Status", "Scanned At", "Backend Status", "Backend Message", "Backend At")
    private val INPUT = listOf("Store", "SKU", "Description", "Serial", "Return Units", "Return Value", "Consignment Status", "Monty Flag")

    // ---------------------------------------------------------------- reading
    /** First sheet of an .xlsx → rows of String / Double / Boolean / null. */
    fun readXlsx(bytes: ByteArray): List<List<Any?>> {
        val files = HashMap<String, ByteArray>()
        ZipInputStream(ByteArrayInputStream(bytes)).use { z ->
            while (true) { val e = z.nextEntry ?: break; if (!e.isDirectory) files[e.name] = z.readBytes() }
        }
        val wb = files["xl/workbook.xml"]?.let(::xml) ?: throw PullbackError("This isn't an .xlsx file.")
        val rid = Regex("<sheet\\b[^>]*\\br:id=\"([^\"]+)\"").find(wb)?.groupValues?.get(1)
        val rels = files["xl/_rels/workbook.xml.rels"]?.let(::xml).orEmpty()
        val target = Regex("<Relationship\\b([^>]*)/?>").findAll(rels).map { it.groupValues[1] }
            .firstOrNull { Regex("\\bId=\"([^\"]+)\"").find(it)?.groupValues?.get(1) == rid }
            ?.let { Regex("\\bTarget=\"([^\"]+)\"").find(it)?.groupValues?.get(1) }
        val path = target?.let { if (it.startsWith("/")) it.drop(1) else "xl/" + it.removePrefix("./") } ?: "xl/worksheets/sheet1.xml"
        val sheet = (files[path] ?: files["xl/worksheets/sheet1.xml"])?.let(::xml) ?: throw PullbackError("This file has no sheet.")
        val shared = files["xl/sharedStrings.xml"]?.let(::xml)?.let { s ->
            Regex("<si>([\\s\\S]*?)</si>|<si/>").findAll(s).map { m -> m.groupValues[1].let(::textOf) }.toList()
        }.orEmpty()
        val rows = ArrayList<List<Any?>>()
        for (rm in Regex("<row\\b([^>]*?)(?:/>|>([\\s\\S]*?)</row>)").findAll(sheet)) {
            val rn = Regex("\\br=\"(\\d+)\"").find(rm.groupValues[1])?.groupValues?.get(1)?.toIntOrNull() ?: (rows.size + 1)
            while (rows.size < rn - 1) rows.add(emptyList())
            val row = ArrayList<Any?>()
            for (cm in Regex("<c\\b([^>]*?)(?:/>|>([\\s\\S]*?)</c>)").findAll(rm.groupValues[2])) {
                val attrs = cm.groupValues[1]; val body = cm.groupValues[2]
                val ci = Regex("\\br=\"([A-Z]+)\\d+\"").find(attrs)?.groupValues?.get(1)?.let(::colIndex) ?: row.size
                val t = Regex("\\bt=\"([^\"]+)\"").find(attrs)?.groupValues?.get(1) ?: "n"
                val v = Regex("<v>([\\s\\S]*?)</v>").find(body)?.groupValues?.get(1)
                val value: Any? = when (t) {
                    "s" -> v?.toIntOrNull()?.let { shared.getOrNull(it) }
                    "inlineStr" -> textOf(body)
                    "str", "e" -> v?.let(::decodeEntities)
                    "b" -> v == "1"
                    else -> v?.takeIf { it.isNotEmpty() }?.toDoubleOrNull()
                }
                while (row.size < ci) row.add(null)
                if (ci < row.size) row[ci] = value else row.add(value)
            }
            rows.add(row)
        }
        return rows
    }

    /** A .csv export → rows (quoted fields, "" escapes; plain numbers become numbers, leading-zero ones stay text). */
    fun readCsv(text: String): List<List<Any?>> {
        val rows = ArrayList<List<Any?>>(); var row = ArrayList<String>(); val cell = StringBuilder(); var q = false; var i = 0
        while (i < text.length) {
            val c = text[i]
            if (q) { if (c == '"') { if (text.getOrNull(i + 1) == '"') { cell.append('"'); i++ } else q = false } else cell.append(c) }
            else when (c) {
                '"' -> q = true
                ',' -> { row.add(cell.toString()); cell.clear() }
                '\n', '\r' -> { if (c == '\r' && text.getOrNull(i + 1) == '\n') i++; row.add(cell.toString()); cell.clear(); rows.add(row.map(::csvValue)); row = ArrayList() }
                else -> cell.append(c)
            }
            i++
        }
        if (cell.isNotEmpty() || row.isNotEmpty()) { row.add(cell.toString()); rows.add(row.map(::csvValue)) }
        return rows
    }
    private fun csvValue(v: String): Any? = when {
        v.isEmpty() -> null
        Regex("^-?\\d+(\\.\\d+)?$").matches(v) && !Regex("^0\\d").containsMatchIn(v) -> v.toDouble()
        else -> v
    }

    // ---------------------------------------------------------------- the list
    private fun normHeader(h: Any?): String {
        var s = h?.toString()?.trim().orEmpty()
        Regex("\\[([^\\]]+)]\\s*$").find(s)?.let { s = it.groupValues[1] }
        return s.trim().trim('\'', '"')
    }
    private fun findCol(headers: List<Any?>, name: String): Int? = headers.indexOfFirst { h ->
        h != null && h.toString().isNotBlank() && (h.toString().trim().equals(name, true) || normHeader(h).equals(name, true))
    }.takeIf { it >= 0 }

    fun norm(s: String?): String = s.orEmpty().trim().uppercase()
    /** "914" from "Newport News Store #914". */
    fun storeNum(s: String?): String = s.orEmpty().let { Regex("#\\s*(\\d+)").find(it) ?: Regex("(\\d+)\\s*$").find(it) }?.groupValues?.get(1).orEmpty()
    private val STAMP: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss")
    fun stamp(now: LocalDateTime = LocalDateTime.now()): String = now.truncatedTo(ChronoUnit.SECONDS).format(STAMP)

    /** rows → the list (an export, or a results file to carry on). Throws [PullbackError] for an empty file or one with no Serial column. */
    fun parse(rows: List<List<Any?>>): PbList {
        if (rows.isEmpty()) throw PullbackError("This file is empty.")
        val hi = (0 until minOf(rows.size, 15)).firstOrNull { findCol(rows[it], "Serial") != null } ?: 0
        val headers = rows[hi].map { it?.toString()?.trim().orEmpty() }
        if (findCol(headers, "Serial") == null) throw PullbackError("No Serial column in this file.")
        val data = rows.drop(hi + 1).filter { r -> r.any { it != null && it != "" } }
        val col = (INPUT + RESULT_HEADERS).associateWith { findCol(headers, it) }
        fun cell(r: List<Any?>, name: String): Any? = col[name]?.let { r.getOrNull(it) }
        fun text(r: List<Any?>, name: String): String = cell(r, name)?.let(::show).orEmpty()
        val results = "Scanned Serial" in headers
        val items = data.mapNotNull { r ->
            val serial = text(r, "Serial").trim()
            if (serial.isEmpty()) return@mapNotNull null
            PbItem(
                store = decodeEntities(text(r, "Store")), sku = cell(r, "SKU"), description = decodeEntities(text(r, "Description")), serial = serial,
                returnUnits = cell(r, "Return Units"), returnValue = cell(r, "Return Value"), consignment = cell(r, "Consignment Status"), monty = cell(r, "Monty Flag"),
                scanned = if (results) text(r, "Scanned Serial") else "", match = if (results) text(r, "Match") else "",
                status = if (results) PbStatus.of(text(r, "Status")) else PbStatus.Pending, scannedAt = if (results) text(r, "Scanned At") else "",
                backendStatus = if (results) text(r, "Backend Status") else "", backendMessage = if (results) text(r, "Backend Message") else "",
                backendAt = if (results) text(r, "Backend At") else "",
            )
        }
        val sorted = if (results) items else items.sortedWith(scanOrder)
        return PbList(headers.filter { it.isNotEmpty() && it !in RESULT_HEADERS }, sorted, results)
    }

    /**
     * Scan order: by part type (the order shelves are usually kept), then by description in natural order (iPhone 6 before iPhone 11),
     * so the same SKU and similar parts sit together; then SKU and serial. The same rules as Aethernet's Elusive Jump.
     */
    private val CATEGORIES = listOf(
        "devices" to Regex("renewed|\\b\\d+\\s?gb\\b", RegexOption.IGNORE_CASE),
        "back glass" to Regex("back glass|housing", RegexOption.IGNORE_CASE),
        "screens" to Regex("glass|\\blcd\\b|\\boled\\b|screen|display|digitizer", RegexOption.IGNORE_CASE),
        "batteries" to Regex("battery", RegexOption.IGNORE_CASE),
        "charging ports" to Regex("charging port|dock connector", RegexOption.IGNORE_CASE),
        "speakers" to Regex("speaker|earpiece", RegexOption.IGNORE_CASE),
        "flex" to Regex("sensor/front camera", RegexOption.IGNORE_CASE),
        "cameras" to Regex("camera", RegexOption.IGNORE_CASE),
        "flex" to Regex("flex|coil|sensor|nfc", RegexOption.IGNORE_CASE),
    )
    private val ORDER = listOf("screens", "batteries", "charging ports", "cameras", "speakers", "flex", "back glass", "devices")
    fun category(description: String): String = CATEGORIES.firstOrNull { it.second.containsMatchIn(description) }?.first ?: "other"
    private fun rank(description: String) = ORDER.indexOf(category(description)).let { if (it < 0) ORDER.size else it }
    private val CHUNK = Regex("\\d+|\\D+")
    fun natural(a: String, b: String): Int {
        val x = CHUNK.findAll(a.trim().lowercase()).map { it.value }.toList()
        val y = CHUNK.findAll(b.trim().lowercase()).map { it.value }.toList()
        for (i in 0 until minOf(x.size, y.size)) {
            val p = x[i]; val q = y[i]; val pn = p[0].isDigit(); val qn = q[0].isDigit()
            if (pn && qn) { val d = p.toBigInteger().compareTo(q.toBigInteger()); if (d != 0) return d }
            else if (pn != qn) return if (pn) -1 else 1
            else if (p != q) return p.compareTo(q)
        }
        return x.size - y.size
    }
    val scanOrder: Comparator<PbItem> = Comparator { a, b ->
        (rank(a.description) - rank(b.description)).takeIf { it != 0 } ?: natural(a.description, b.description).takeIf { it != 0 }
            ?: natural(a.skuText, b.skuText).takeIf { it != 0 } ?: natural(a.serial, b.serial)
    }

    /** The stores in a list with their item counts, by store number. */
    fun stores(items: List<PbItem>): List<Pair<String, Int>> = items.groupingBy { it.store }.eachCount().filterKeys { it.isNotEmpty() }.toList()
        .sortedWith(compareBy<Pair<String, Int>> { storeNum(it.first).toIntOrNull() ?: 0 }.thenBy { it.first })

    fun forStore(items: List<PbItem>, store: String): List<PbItem> = items.filter { it.store == store }

    /** The results file name: "Pullback Serials - 914 - Scan Results.xlsx". */
    fun fileName(source: String?, store: String?): String {
        val base = (source ?: "Pullback Serials.xlsx").replace(Regex("\\.[^.]+$"), "").replace(Regex("( - \\d+)? - Scan Results$"), "")
        val n = storeNum(store)
        return base + (if (n.isNotEmpty()) " - $n" else "") + " - Scan Results.xlsx"
    }

    enum class Fill(val rgb: String) { Ok("C6EFCE"), Bad("FFC7CE"), Warn("FFEB9C") }
    fun fillOf(it: PbItem): Fill? = when {
        it.status == PbStatus.Matched && it.backendStatus != ALREADY -> Fill.Ok
        it.status == PbStatus.Mismatch -> Fill.Bad
        it.status == PbStatus.Overridden || it.status == PbStatus.Skipped || it.backendStatus == ALREADY -> Fill.Warn
        else -> null
    }
    const val ALREADY = "skipped-already-marked"

    /** The results .xlsx. */
    fun results(list: PbList): ByteArray {
        val out = list.headers + RESULT_HEADERS.filter { it !in list.headers }
        val rows = listOf<List<Any?>>(out) + list.items.map { it -> out.map { h -> it.field(normHeader(h).ifEmpty { h }) ?: it.field(h) } }
        return writeXlsx(rows, list.items.map(::fillOf), "Scan Results")
    }

    // ---------------------------------------------------------------- writing
    fun writeXlsx(rows: List<List<Any?>>, fills: List<Fill?>, sheetName: String): ByteArray {
        val width = rows.maxOfOrNull { it.size } ?: 0
        val widths = (0 until width).map { c -> ((rows.maxOfOrNull { r -> r.getOrNull(c)?.let(::show)?.length ?: 0 } ?: 0) + 2).coerceIn(10, 50) }
        val sheet = StringBuilder(X).append("<worksheet xmlns=\"$NS\"><cols>")
        widths.forEachIndexed { i, w -> sheet.append("<col min=\"${i + 1}\" max=\"${i + 1}\" width=\"$w\" customWidth=\"1\"/>") }
        sheet.append("</cols><sheetData>")
        rows.forEachIndexed { i, r ->
            val s = if (i == 0) 1 else when (fills.getOrNull(i - 1)) { Fill.Ok -> 2; Fill.Bad -> 3; Fill.Warn -> 4; null -> 0 }
            sheet.append("<row r=\"${i + 1}\">")
            for (c in 0 until width) {
                val ref = colName(c) + (i + 1); val sa = if (s != 0) " s=\"$s\"" else ""
                when (val v = r.getOrNull(c)) {
                    null, "" -> if (s != 0) sheet.append("<c r=\"$ref\"$sa/>")
                    is Number -> sheet.append("<c r=\"$ref\"$sa><v>").append(show(v)).append("</v></c>")
                    is Boolean -> sheet.append("<c r=\"$ref\"$sa t=\"b\"><v>${if (v) 1 else 0}</v></c>")
                    else -> sheet.append("<c r=\"$ref\"$sa t=\"inlineStr\"><is><t xml:space=\"preserve\">").append(esc(v.toString())).append("</t></is></c>")
                }
            }
            sheet.append("</row>")
        }
        sheet.append("</sheetData></worksheet>")
        fun fill(rgb: String) = "<fill><patternFill patternType=\"solid\"><fgColor rgb=\"FF$rgb\"/><bgColor rgb=\"FF$rgb\"/></patternFill></fill>"
        val styles = X + "<styleSheet xmlns=\"$NS\"><fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font><font><b/><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts>" +
            "<fills count=\"5\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill>" + Fill.entries.joinToString("") { fill(it.rgb) } + "</fills>" +
            "<borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>" +
            "<cellXfs count=\"5\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/><xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\"/>" +
            (2..4).joinToString("") { "<xf numFmtId=\"0\" fontId=\"0\" fillId=\"$it\" borderId=\"0\" xfId=\"0\" applyFill=\"1\"/>" } + "</cellXfs>" +
            "<cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles></styleSheet>"
        val parts = linkedMapOf(
            "[Content_Types].xml" to X + "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/></Types>",
            "_rels/.rels" to X + "<Relationships xmlns=\"$REL_NS\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>",
            "xl/workbook.xml" to X + "<workbook xmlns=\"$NS\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"${esc(sheetName)}\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>",
            "xl/_rels/workbook.xml.rels" to X + "<Relationships xmlns=\"$REL_NS\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/></Relationships>",
            "xl/styles.xml" to styles,
            "xl/worksheets/sheet1.xml" to sheet.toString(),
        )
        val bos = ByteArrayOutputStream()
        ZipOutputStream(bos).use { z -> parts.forEach { (name, text) -> z.putNextEntry(ZipEntry(name)); z.write(text.toByteArray()); z.closeEntry() } }
        return bos.toByteArray()
    }

    // ---------------------------------------------------------------- helpers
    private const val X = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
    private const val NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    private const val REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
    /** XML text with element prefixes dropped (PowerBI writes `<x:row>`, Excel `<row>`). */
    private fun xml(b: ByteArray): String = String(b, Charsets.UTF_8).removePrefix("\uFEFF").replace(Regex("<(/?)[A-Za-z_][\\w.-]*:"), "<$1")
    private fun textOf(x: String): String = Regex("<t(?:\\s[^>]*)?>([\\s\\S]*?)</t>").findAll(x).joinToString("") { decodeEntities(it.groupValues[1]) }
    private fun colIndex(letters: String): Int = letters.fold(0) { n, ch -> n * 26 + (ch - 'A' + 1) } - 1
    private fun colName(i: Int): String { var n = i + 1; val sb = StringBuilder(); while (n > 0) { val r = (n - 1) % 26; sb.insert(0, ('A' + r)); n = (n - 1) / 26 }; return sb.toString() }
    private fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").filter { it == '\t' || it == '\n' || it == '\r' || it >= ' ' }
    private val ENT = mapOf("amp" to "&", "lt" to "<", "gt" to ">", "quot" to "\"", "apos" to "'", "nbsp" to "\u00a0")
    fun decodeEntities(s: String): String = Regex("&(#x[0-9a-fA-F]+|#\\d+|[a-zA-Z]+);").replace(s) { m ->
        val e = m.groupValues[1]
        when {
            e.startsWith("#x") || e.startsWith("#X") -> e.drop(2).toIntOrNull(16)?.let { String(Character.toChars(it)) } ?: m.value
            e.startsWith("#") -> e.drop(1).toIntOrNull()?.let { String(Character.toChars(it)) } ?: m.value
            else -> ENT[e.lowercase()] ?: m.value
        }
    }
    /** A cell as text: whole numbers without ".0". */
    fun show(v: Any): String = when (v) {
        is Double -> if (v == Math.rint(v) && !v.isInfinite() && kotlin.math.abs(v) < 1e15) v.toLong().toString() else v.toString()
        is Float -> show(v.toDouble())
        else -> v.toString()
    }
}

class PullbackError(message: String) : Exception(message)

enum class PbStatus(val text: String) {
    Pending("pending"), Matched("matched"), Mismatch("mismatch"), Overridden("overridden"), Skipped("skipped");
    companion object { fun of(s: String?): PbStatus = entries.firstOrNull { it.text == s?.trim() } ?: Pending }
}

/** One serial on the list and what happened to it. The input columns keep their cell values (numbers stay numbers in the results file). */
data class PbItem(
    val store: String,
    val sku: Any?,
    val description: String,
    val serial: String,
    val returnUnits: Any? = null,
    val returnValue: Any? = null,
    val consignment: Any? = null,
    val monty: Any? = null,
    val scanned: String = "",
    val match: String = "",
    val status: PbStatus = PbStatus.Pending,
    val scannedAt: String = "",
    val backendStatus: String = "",
    val backendMessage: String = "",
    val backendAt: String = "",
) {
    val skuText: String get() = sku?.let { Pullbacks.show(it) }.orEmpty()
    val done: Boolean get() = status == PbStatus.Matched || status == PbStatus.Overridden
    fun reset(): PbItem = copy(scanned = "", match = "", status = PbStatus.Pending, scannedAt = "", backendStatus = "", backendMessage = "", backendAt = "")
    internal fun field(header: String): Any? = when (header) {
        "Store" -> store; "SKU" -> sku; "Description" -> description; "Serial" -> serial
        "Return Units" -> returnUnits; "Return Value" -> returnValue; "Consignment Status" -> consignment; "Monty Flag" -> monty
        "Scanned Serial" -> scanned; "Match" -> match; "Status" -> status.text; "Scanned At" -> scannedAt
        "Backend Status" -> backendStatus; "Backend Message" -> backendMessage; "Backend At" -> backendAt
        else -> null
    }
}

/** A parsed file: its input headers (in order), its items, and whether it was a results file. */
data class PbList(val headers: List<String>, val items: List<PbItem>, val results: Boolean = false)
