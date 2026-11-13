package dev.aethernet.linkpearl.feature.workorders

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.Instant

/*
 * Decoded sealed data. These objects hold customer details: they live only in view-model memory while unlocked, are dropped on lock,
 * and are never logged, persisted or put in saved state. Their toString() is redacted so they cannot leak through a log line or
 * a crash report by accident.
 */

/** The search card (`cardOf` in tracker-worker/src/shape.js). */
class Card(
    val name: String?,
    val phones: List<String>,
    val emails: List<String>,
    val imei: String?,
    val serial: String?,
    val claim: String?,
) {
    override fun toString() = "Card(redacted)"

    companion object {
        fun from(e: JsonElement): Card {
            val o = e as? JsonObject ?: JsonObject(emptyMap())
            return Card(
                name = o.str("name"),
                phones = o.arr("phones").mapNotNull { (it as? JsonPrimitive)?.contentOrNullSafe()?.let(::digitsOf)?.takeIf { d -> d.isNotEmpty() } }.distinct(),
                emails = o.arr("emails").mapNotNull { (it as? JsonPrimitive)?.contentOrNullSafe() },
                imei = o.str("imei"),
                serial = o.str("serial"),
                claim = o.str("claim"),
            )
        }
    }
}

enum class NoteKind { Automatic, Manual, Unknown }

class Note(val text: String, val createdAt: String?, val kind: NoteKind, val tag: String?, val author: String?) {
    override fun toString() = "Note(redacted)"
}

/** What the detail shows after unlocking: contact from the card (snapshot as fallback), device ids, notes newest first. */
class Unsealed(
    val name: String?,
    val phones: List<String>,
    val emails: List<String>,
    val imei: String?,
    val serial: String?,
    val notes: List<Note>,
    /** Portal's note count; more than [notes] when the tracker stored only part of them. */
    val notesTotal: Int?,
    val fetchedAt: String?,
    val hasSnapshot: Boolean,
) {
    override fun toString() = "Unsealed(redacted)"

    companion object {
        /** Defensive: every field optional; a broken note is skipped, never a crash. */
        fun from(card: Card?, snapshot: JsonElement?, fetchedAt: String?): Unsealed {
            val s = snapshot as? JsonObject
            val cust = s?.obj("customer_data")
            val dev = s?.obj("workorder")?.obj("workorder")?.obj("CustomerDevice")
            val notesObj = s?.obj("notes")
            val notes = notesObj?.arr("notes").orEmpty().mapNotNull { noteOf(it) }
            return Unsealed(
                name = card?.name ?: cust?.obj("CustomerDatum")?.str("fullName")
                    ?: listOfNotNull(cust?.obj("CustomerDatum")?.str("givenName"), cust?.obj("CustomerDatum")?.str("familyName")).joinToString(" ").ifBlank { null },
                phones = card?.phones?.takeIf { it.isNotEmpty() }
                    ?: cust?.arr("CustomerDataPhones").orEmpty().mapNotNull { (it as? JsonObject)?.str("phone")?.let(::digitsOf)?.takeIf { d -> d.isNotEmpty() } }.distinct(),
                emails = card?.emails?.takeIf { it.isNotEmpty() }
                    ?: cust?.arr("CustomerDataEmails").orEmpty().mapNotNull { (it as? JsonObject)?.str("email")?.lowercase() }.distinct(),
                imei = card?.imei ?: dev?.str("imei"),
                serial = card?.serial ?: dev?.str("serial"),
                notes = sortNewestFirst(notes),
                notesTotal = notesObj?.int("total"),
                fetchedAt = fetchedAt,
                hasSnapshot = s != null,
            )
        }

        fun noteOf(e: JsonElement): Note? {
            val o = e as? JsonObject ?: return null
            val text = o.str("noteText")?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            val kind = when (o.int("noteType")) { 1 -> NoteKind.Automatic; 2 -> NoteKind.Manual; else -> NoteKind.Unknown }
            val user = o.obj("UserDatum")
            val given = user?.str("givenName")?.trim().orEmpty()
            val family = user?.str("familyName")?.trim().orEmpty()
            val author = when {
                given.isNotEmpty() && family.isNotEmpty() -> "$given ${family.first()}."
                given.isNotEmpty() -> given
                family.isNotEmpty() -> family
                else -> null
            }
            return Note(text, o.str("createdAt"), kind, o.str("noteTag"), author)
        }

        /** Newest first by createdAt; notes without a readable time keep their place after the dated ones. */
        fun sortNewestFirst(notes: List<Note>): List<Note> {
            val (dated, undated) = notes.partition { n -> n.createdAt?.let { runCatching { Instant.parse(it) }.isSuccess } == true }
            return dated.sortedByDescending { Instant.parse(it.createdAt) } + undated
        }
    }
}

// ---- local search over decrypted cards ------------------------------------------------------------------------------------------

/** One searchable work order: its plain row and the decrypted card. In memory only, dropped on lock. */
class IndexEntry(val row: WoRow, val card: Card) {
    override fun toString() = "IndexEntry(${row.store}-${row.wo})"
}

object CardMatch {
    /**
     * Name: case-insensitive "contains" (and every word of a multi-word query). Phone: 4+ digits anywhere in a number (a leading
     * US 1 is ignored). IMEI / serial: suffix of 4+ characters, or the full value. Email and claim: contains / equals.
     */
    fun matches(card: Card, query: String): Boolean {
        val q = query.trim()
        if (q.isEmpty()) return false
        val lower = q.lowercase()
        val digits = digitsOf(q).let { if (it.length == 11 && it.startsWith("1")) it.substring(1) else it }
        val numberish = q.all { it.isDigit() || it in " ()+-." }
        if (!numberish) {
            val name = card.name?.lowercase().orEmpty()
            if (name.isNotEmpty() && (name.contains(lower) || lower.split(Regex("\\s+")).all { name.contains(it) })) return true
            if (card.emails.any { it.lowercase().contains(lower) }) return true
            if (card.claim?.lowercase() == lower) return true
        }
        if (q.length >= 4) {
            val compact = lower.replace(" ", "")
            if (card.serial?.lowercase()?.let { it == compact || (compact.length >= 4 && it.endsWith(compact)) } == true) return true
        }
        if (numberish && digits.length >= 4) {
            if (card.phones.any { it.contains(digits) }) return true
            if (card.imei?.let { digitsOf(it) }?.let { it == digits || it.endsWith(digits) } == true) return true
        }
        return false
    }

    fun search(index: List<IndexEntry>, query: String): List<IndexEntry> = index.filter { matches(it.card, query) }
}

fun digitsOf(s: String): String = s.filter { it.isDigit() }

// ---- JSON helpers that never throw ------------------------------------------------------------------------------------------------

private fun JsonPrimitive.contentOrNullSafe(): String? = if (this is JsonNull) null else content
internal fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.let { if (it is JsonNull) null else it.content }
internal fun JsonObject.int(k: String): Int? = (this[k] as? JsonPrimitive)?.let { if (it is JsonNull) null else it.content.toDoubleOrNull()?.toInt() }
internal fun JsonObject.obj(k: String): JsonObject? = this[k] as? JsonObject
internal fun JsonObject.arr(k: String): List<JsonElement> = (this[k] as? JsonArray)?.toList().orEmpty()
