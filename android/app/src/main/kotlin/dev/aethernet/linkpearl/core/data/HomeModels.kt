package dev.aethernet.linkpearl.core.data

import kotlinx.serialization.Serializable

/**
 * The Home payload: `GET /api/m/home?store=<id>|all` (tracker-worker/src/mobile.js, `homeApi`).
 * A null number means "no data" and is drawn as a dash, never 0. Unknown JSON keys are ignored (see [LinkpearlJson]).
 */
@Serializable
data class HomeData(
    val v: Int = 1,
    val now: String? = null,
    val tz: String = "America/New_York",
    val today: String? = null,
    val stores: List<StoreRef> = emptyList(),
    val days: List<String> = emptyList(),
    val sales: Sales = Sales(),
    val splh: Splh = Splh(),
    val rfp: Rfp = Rfp(),
    val lanes: Lanes = Lanes(),
    val cleaning: Cleaning = Cleaning(),
    val asOf: String? = null,
    val stale: Boolean = false,
    val behind: StoreRef? = null,
    /** Present on All stores only. */
    val byStore: List<ByStore>? = null,
    /** True when the account has no stores (the server answers `{ v, stores: [], empty: true }`). */
    val empty: Boolean = false,
)

@Serializable
data class StoreRef(val id: Int, val name: String? = null) {
    /** "Name #id" as the store switcher shows it. */
    val label: String get() = if (name.isNullOrBlank()) "#$id" else "$name #$id"
}

@Serializable
data class Sales(
    val today: Double? = null,
    val yesterday: Double? = null,
    /** Seven store-local days, oldest first; null = no data for that day. */
    val week: List<Double?> = emptyList(),
)

@Serializable
data class Splh(
    val today: Double? = null,
    val hours: Double? = null,
    val week: List<Double?> = emptyList(),
    /** Target band in dollars, [low, high]. */
    val target: List<Int> = listOf(160, 180),
)

@Serializable
data class Rfp(
    val total: Double? = null,
    val count: Int = 0,
    val oldestDays: Int? = null,
    val ages: List<AgeBucket> = emptyList(),
)

@Serializable
data class AgeBucket(val label: String, val n: Int)

@Serializable
data class Lanes(
    val order: Int = 0,
    val start: Int = 0,
    val work: Int = 0,
    val wait: Int = 0,
    val rfp: Int = 0,
    val total: Int = 0,
)

@Serializable
data class Cleaning(
    val cln: Int? = null,
    val am: Int? = null,
    val rate: Double? = null,
    val week: List<Double?> = emptyList(),
)

@Serializable
data class ByStore(
    val id: Int,
    val name: String? = null,
    val asOf: String? = null,
    val stale: Boolean = false,
    val sales: Double? = null,
    val splh: Double? = null,
) {
    val label: String get() = if (name.isNullOrBlank()) "#$id" else "$name #$id"
}
