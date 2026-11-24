package dev.aethernet.linkpearl.feature.prices

import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.data.notFoundAsServer
import java.util.concurrent.ConcurrentHashMap

/** The store's Price sheet. [RealPricesRepository] asks the server; [FakePricesRepository] answers for tests and screenshots. */
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

/** Answers from [FakePrices]; [devicesAnswer] / [pricesAnswer] override. Records every call. */
class FakePricesRepository(
    var devicesAnswer: ((Int) -> ApiResult<PriceDevices>)? = null,
    var pricesAnswer: ((Int, String) -> ApiResult<PriceMatches>)? = null,
) : PricesRepository {
    val deviceCalls = mutableListOf<Int>()
    val priceCalls = mutableListOf<Pair<Int, String>>()
    override suspend fun devices(store: Int, fresh: Boolean): ApiResult<PriceDevices> {
        deviceCalls += store
        return devicesAnswer?.invoke(store) ?: ApiResult.Success(if (store == FakePrices.STORE) FakePrices.devices else PriceDevices(store, null, emptyList()))
    }
    override suspend fun prices(store: Int, q: String): ApiResult<PriceMatches> {
        priceCalls += store to q
        return pricesAnswer?.invoke(store, q) ?: ApiResult.Success(FakePrices.matchesFor(q))
    }
}

/** An invented sheet in the shape of the approved mockup (store Sandbox #999999, synced 9:40 AM Nov 13 2026). */
object FakePrices {
    const val STORE = 999999
    const val SYNCED = "2026-11-13T14:40:00Z"

    val devices = PriceDevices(
        STORE, SYNCED,
        listOf(
            PriceDevice("iphone15promax", "iPhone 15 Pro Max", "Apple"), PriceDevice("iphone15pro", "iPhone 15 Pro", "Apple"),
            PriceDevice("iphone15plus", "iPhone 15 Plus", "Apple"), PriceDevice("iphone15", "iPhone 15", "Apple"),
            PriceDevice("iphone14pro", "iPhone 14 Pro", "Apple"), PriceDevice("s24ultra", "Galaxy S24 Ultra", "Samsung"),
            PriceDevice("zfold5", "Galaxy Z Fold 5", "Samsung"), PriceDevice("pixel8pro", "Pixel 8 Pro", "Google"),
            PriceDevice("ps5", "Sony PS5", "Game Console"),
        ),
    )

    val iphone15Pro = PriceMatch(
        "iPhone 15 Pro", "Apple", null,
        listOf(
            PriceRepair("Screen", "Screen", 289.99, "$289.99"), PriceRepair("Screen", "UB Screen", 219.99, "$219.99"),
            PriceRepair("Battery", "Battery", 99.99, "$99.99"), PriceRepair("Charge port", "Charging Port", 129.99, "$129.99"),
            PriceRepair("Back glass", "Back Glass", 199.99, "$199.99"), PriceRepair("Back Camera", "Back Camera", 159.99, "$159.99"),
            PriceRepair("Front Camera", "Front Camera", null, "N/A"),
        ),
    )

    val fold = listOf(
        PriceMatch("Galaxy Z Fold 5 Inner", "Samsung", "inner", listOf(PriceRepair("Screen", "OLED", 549.99, "$549.99"), PriceRepair("Battery", "Battery", 129.99, "$129.99"))),
        PriceMatch("Galaxy Z Fold 5 Outer", "Samsung", "outer", listOf(PriceRepair("Screen", "OLED", 219.99, "$219.99"), PriceRepair("Battery", "Battery", null, "Samsung self repair"))),
    )

    fun matchesFor(q: String): PriceMatches = PriceMatches(
        STORE, SYNCED,
        when (q) {
            "iphone15pro", "iPhone 15 Pro" -> listOf(iphone15Pro)
            "zfold5", "Galaxy Z Fold 5" -> fold
            else -> devices.devices.firstOrNull { it.key == q || it.name == q }?.let { d ->
                listOf(PriceMatch(d.name, d.tab, null, listOf(PriceRepair("Screen", "Screen", 249.99, "$249.99"), PriceRepair("Battery", "Battery", 89.99, "$89.99"))))
            } ?: emptyList()
        },
    )
}
