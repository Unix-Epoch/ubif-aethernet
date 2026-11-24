package dev.aethernet.linkpearl.feature.trends

import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.data.StoreScope
import dev.aethernet.linkpearl.core.data.decode

/** Where Trends gets its numbers. [RealTrendsRepository] asks the server; the tests have a fake. */
interface TrendsRepository {
    /** [at] = any day inside the wanted period (`YYYY-MM-DD`), null for the current one. [fresh] = a manual refresh (skips the server's cache). */
    suspend fun load(scope: StoreScope, period: TrendPeriod, at: String?, fresh: Boolean = false): ApiResult<TrendsData>
}

/**
 * `GET /v1/agents/m/trends?store=<id>|all&period=week|month|year[&at=][&fresh=1]`. Nothing is kept on the phone. A 404 (a tracker without the
 * route) reads as the generic "Couldn't load"; an answer that does not decode likewise.
 */
class RealTrendsRepository(private val api: ApiClient) : TrendsRepository {
    override suspend fun load(scope: StoreScope, period: TrendPeriod, at: String?, fresh: Boolean): ApiResult<TrendsData> {
        val query = buildMap {
            put("store", scope.key); put("period", period.key)
            if (at != null) put("at", at)
            if (fresh) put("fresh", "1")
        }
        return api.get(PATH, query).decode(TrendsData.serializer(), notFoundAsServer = true)
    }

    companion object {
        const val PATH = "/v1/agents/m/trends"
    }
}
