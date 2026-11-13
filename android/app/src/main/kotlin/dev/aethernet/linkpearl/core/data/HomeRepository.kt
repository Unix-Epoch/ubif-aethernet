package dev.aethernet.linkpearl.core.data

import kotlinx.serialization.json.Json

/** JSON settings for every API payload: tolerate keys this version of the app does not know. */
val LinkpearlJson: Json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true }

/** Which stores Home shows. [key] is what the API's `store=` parameter and the saved preference use. */
sealed interface StoreScope {
    val key: String

    data object All : StoreScope { override val key = "all" }
    data class One(val id: Int) : StoreScope { override val key = id.toString() }

    companion object {
        fun fromKey(key: String?): StoreScope = key?.toIntOrNull()?.let(::One) ?: All
    }
}

enum class FailureReason { Offline, Server, Unauthorized }

sealed interface HomeResult {
    /** [cached] = the answer came from the phone's last-known copy because the network is unavailable (drawn as "Offline"). */
    data class Ok(val data: HomeData, val cached: Boolean = false) : HomeResult
    data class Failed(val reason: FailureReason) : HomeResult
}

/**
 * Source of Home's numbers. The real implementation (agent A) calls `GET /api/m/home` through [ApiClient] and keeps the last answer
 * on disk so it can be returned with `cached = true` when offline. The fake in [FakeHomeRepository] drives the UI until then.
 */
interface HomeRepository {
    /** [fresh] = the refresh button was pressed: skip any server-side cache (`&fresh=1`). */
    suspend fun load(scope: StoreScope, fresh: Boolean = false): HomeResult
}
