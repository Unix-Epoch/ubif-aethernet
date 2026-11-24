package dev.aethernet.linkpearl.feature.prices

import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.data.notFoundAsServer
import java.util.concurrent.ConcurrentHashMap

/** The store's Price sheet. [RealPricesRepository] asks the server; the tests have a fake. */
interface PricesRepository {
    /** Every quotable device of [store]'s sheet. [fresh] skips the phone's copy. */
    suspend fun devices(store: Int, fresh: Boolean = false): ApiResult<PriceDevices>
    /** One device's prices; [q] is a device `key` (finds exactly that device) or any device text. */
    suspend fun prices(store: Int, q: String): ApiResult<PriceMatches>
}

/**
 * `GET /v1/agents/m/prices?store=<id>[&q=]`. The device list is kept in memory per store until [devices] is asked with `fresh`, or a prices
 * answer carries another `syncedAt` (the sheet was synced again). A 404 reads as the generic "Couldn't load".
 */
class RealPricesRepository(private val api: ApiClient) : PricesRepository {
    private val lists = ConcurrentHashMap<Int, PriceDevices>()

    override suspend fun devices(store: Int, fresh: Boolean): ApiResult<PriceDevices> {
        if (!fresh) lists[store]?.let { return ApiResult.Success(it) }
        return when (val r = api.get(PATH, mapOf("store" to store.toString()))) {
            is ApiResult.Success -> ApiResult.Success(PriceParse.devices(r.value).also { lists[store] = it })
            is ApiResult.Failure -> r.notFoundAsServer()
        }
    }

    override suspend fun prices(store: Int, q: String): ApiResult<PriceMatches> =
        when (val r = api.get(PATH, mapOf("store" to store.toString(), "q" to q.trim().take(80)))) {
            is ApiResult.Success -> {
                val m = PriceParse.matches(r.value)
                lists[store]?.let { if (it.syncedAt != m.syncedAt) lists.remove(store) }
                ApiResult.Success(m)
            }
            is ApiResult.Failure -> r.notFoundAsServer()
        }

    companion object {
        const val PATH = "/v1/agents/m/prices"
    }
}
