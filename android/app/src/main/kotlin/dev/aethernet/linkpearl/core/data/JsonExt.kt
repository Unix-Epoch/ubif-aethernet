package dev.aethernet.linkpearl.core.data

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

/*
 * Reading one key of a JSON object by hand. None of these throw: a missing key, a JSON null or a value of another shape gives null
 * (or the empty value where the name has no "OrNull"). The text readers differ on purpose, so pick by name:
 *   str / strOrNull   any primitive as text (a number 5 reads "5")
 *   jsonStrOrNull     only a real JSON string (a number or a boolean reads null)
 *   intOrNull         only a whole number that fits an Int
 *   intLenientOrNull  any number or numeric text, the fraction dropped ("12.0" and 12.7 read 12)
 */

/** Any primitive's text; "" when there is none. */
internal fun JsonObject.str(k: String): String = strOrNull(k).orEmpty()

/** Any primitive's text (a number or boolean as written). */
internal fun JsonObject.strOrNull(k: String): String? = (this[k] as? JsonPrimitive)?.contentOrNull

/** The value only when it is a JSON string. */
internal fun JsonObject.jsonStrOrNull(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

internal fun JsonObject.intOrNull(k: String): Int? = (this[k] as? JsonPrimitive)?.intOrNull

/** A number or numeric text, the fraction dropped. */
internal fun JsonObject.intLenientOrNull(k: String): Int? = strOrNull(k)?.toDoubleOrNull()?.toInt()

internal fun JsonObject.longOrNull(k: String): Long? = (this[k] as? JsonPrimitive)?.longOrNull

internal fun JsonObject.boolOrNull(k: String): Boolean? = (this[k] as? JsonPrimitive)?.booleanOrNull

/** The value only when it is a JSON number (numeric text reads null). */
internal fun JsonObject.numOrNull(k: String): Double? = (this[k] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull

internal fun JsonObject.objOrNull(k: String): JsonObject? = this[k] as? JsonObject

internal fun JsonObject.arrOrNull(k: String): JsonArray? = this[k] as? JsonArray

/** The array's elements; empty when there is no array. */
internal fun JsonObject.arr(k: String): List<JsonElement> = arrOrNull(k).orEmpty()
