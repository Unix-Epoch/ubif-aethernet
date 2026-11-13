package dev.aethernet.linkpearl.feature.workorders

import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.lock.AppLock
import dev.aethernet.linkpearl.core.lock.Keyring
import dev.aethernet.linkpearl.core.lock.SealedOpener
import dev.aethernet.linkpearl.core.lock.TestCrypto
import dev.aethernet.linkpearl.core.lock.UnlockAttempt
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes

/** Responses copied from tracker-worker/MOBILE-API-wo.md (real output of the server tests, invented data). */
object WoFixtures {
    const val LIST_OPEN = """{"v":1,"now":"2026-11-13T17:02:25.294Z","state":"open","sort":"status","scope":914,"stores":[914],"rows":[
      {"store":914,"wo":7000001,"open":true,"statusId":2,"status":"Need to order","lane":"order","device":"Galaxy S23 Ultra","program":"Retail","bin":null,"outcome":null,"cartValue":null,"cartDue":null,"statusSince":"2026-11-08T17:02:24.673Z","createdAt":"2026-11-05T09:02:23.384Z","updatedAt":"2026-11-13T16:02:23.384Z","closedAt":null,"notes":3},
      {"store":914,"wo":7000003,"open":true,"statusId":13,"status":"Ready for pickup","lane":"rfp","device":"Galaxy S23 Ultra","program":"Retail","bin":null,"outcome":null,"cartValue":149,"cartDue":149,"statusSince":"2026-11-12T17:02:23.484Z","createdAt":"2026-11-05T09:02:23.384Z","updatedAt":"2026-11-13T16:02:23.384Z","closedAt":null,"notes":1}
    ],"next":"eyJzIjoic3RhdHVzIiwidCI6Im9wZW4iLCJlIjoifiIsInN0Ijo5MTQsInciOjF9","lanes":{"order":3,"start":2,"work":2,"wait":2,"rfp":2,"total":11}}"""

    const val LIST_RECENT = """{"v":1,"now":"2026-11-13T17:02:25.319Z","state":"recent","sort":"closed","scope":914,"stores":[914],"rows":[
      {"store":914,"wo":7000010,"open":false,"statusId":14,"status":"Sale complete","lane":null,"device":"Galaxy S23 Ultra","program":"Retail","bin":null,"outcome":null,"cartValue":null,"cartDue":null,"statusSince":null,"createdAt":"2026-11-05T09:02:23.384Z","updatedAt":"2026-11-13T16:02:23.384Z","closedAt":"2026-11-10T17:02:23.688Z","notes":0}
    ],"next":null,"closedDays":14}"""

    const val FIND = """{"v":1,"now":"2026-11-13T17:02:25.327Z","q":"70000","rows":[
      {"store":914,"wo":7000001,"open":true,"statusId":2,"status":"Need to order","lane":"order","device":"Galaxy S23 Ultra","program":"Retail","bin":null,"outcome":null,"cartValue":null,"cartDue":null,"statusSince":"2026-11-08T17:02:24.673Z","createdAt":"2026-11-05T09:02:23.384Z","updatedAt":"2026-11-13T16:02:23.384Z","closedAt":null,"notes":3}
    ],"more":true}"""

    const val DETAIL = """{"v":1,"now":"2026-11-13T17:02:25.346Z","wo":{"store":914,"wo":7000003,"open":true,"statusId":13,"status":"Ready for pickup","lane":"rfp","device":"Galaxy S23 Ultra","program":"Retail","bin":null,"outcome":null,"cartValue":149,"cartDue":149,"statusSince":"2026-11-12T17:02:23.484Z","createdAt":"2026-11-05T09:02:23.384Z","updatedAt":"2026-11-13T16:02:23.384Z","closedAt":null,"notes":1,"nextUpdate":"2026-11-13T21:02:23.484Z","slaEnd":"2026-11-14T17:02:23.484Z","rfpAt":null,"outcomeReason":null,"closedReason":null,"soldAt":null},
      "timeline":[{"statusId":13,"status":"Ready for pickup","lane":"rfp","start":"2026-11-12T17:02:23.484Z","end":null,"seconds":86402,"current":true},{"statusId":9,"status":"Diagnostics","lane":"work","start":"2026-11-10T19:02:23.484Z","end":"2026-11-12T17:02:23.484Z","seconds":165600,"current":false}],
      "timelineSource":"periods",
      "cart":{"value":149,"total":149,"paid":0,"due":149,"lines":[{"name":"Screen","sku":"1001","quantity":1,"price":149,"totalPrice":149,"partStatus":"Reserved"},{"name":"Labor","sku":"9","quantity":1,"price":0,"totalPrice":0,"partStatus":null}]}}"""

    /** The detail of the test-vector work order (store 914, wo 700000123) with the doc's sealed card and snapshot. */
    val DETAIL_VECTOR_SEALED = DETAIL.replace("\"wo\":7000003", "\"wo\":700000123").trimEnd().removeSuffix("}") +
        ""","sealed":{"card":"${TestCrypto.VECTOR_CARD}","snapshot":{"id":6,"fetchedAt":"2026-11-13T17:02:23.485Z","sealed":"${TestCrypto.VECTOR_SNAPSHOT}"}}}"""

    /** A cards=1 page: the doc's first row, renumbered to the vector's work order so the vector card's aad matches. */
    val LIST_CARDS = """{"v":1,"now":"2026-11-13T17:02:25.309Z","state":"open","sort":"status","scope":"all","stores":[914],"rows":[
      {"store":914,"wo":700000123,"open":true,"statusId":2,"status":"Need to order","lane":"order","device":"Galaxy S23 Ultra","program":"Retail","bin":null,"outcome":null,"cartValue":null,"cartDue":null,"statusSince":"2026-11-08T17:02:24.673Z","createdAt":"2026-11-05T09:02:23.384Z","updatedAt":"2026-11-13T16:02:23.384Z","closedAt":null,"notes":3,"card":"${TestCrypto.VECTOR_CARD}"},
      {"store":914,"wo":7000003,"open":true,"statusId":13,"status":"Ready for pickup","lane":"rfp","device":"Galaxy S23 Ultra","program":"Retail","bin":null,"outcome":null,"cartValue":149,"cartDue":149,"statusSince":"2026-11-12T17:02:23.484Z","createdAt":"2026-11-05T09:02:23.384Z","updatedAt":"2026-11-13T16:02:23.384Z","closedAt":null,"notes":1,"card":null}
    ],"next":null,"lanes":{"order":3,"start":2,"work":2,"wait":2,"rfp":2,"total":11},"cards":true,"cardsFor":[914],"noKey":[]}"""

    const val RECENT_CARDS_EMPTY = """{"v":1,"now":"2026-11-13T17:02:25.319Z","state":"recent","sort":"closed","stores":[914],"rows":[],"next":null,"cards":true,"cardsFor":[914],"noKey":[]}"""

    fun json(s: String): JsonElement = Json.parseToJsonElement(s)
}

/** Answers by a matcher over path and query; records every call. */
class FakeApi : ApiClient {
    val calls = mutableListOf<Pair<String, Map<String, String>>>()
    val routes = mutableListOf<Pair<(String, Map<String, String>) -> Boolean, ApiResult<JsonElement>>>()

    fun on(match: (String, Map<String, String>) -> Boolean, json: String) { routes.add(0, match to ApiResult.Success(WoFixtures.json(json))) }
    fun fail(match: (String, Map<String, String>) -> Boolean, f: ApiResult.Failure) { routes.add(0, match to f) }

    override suspend fun get(path: String, query: Map<String, String>): ApiResult<JsonElement> {
        calls += path to query
        return routes.firstOrNull { it.first(path, query) }?.second ?: ApiResult.Failure(ApiError.NotFound, 404, "no such route in the test")
    }
    override suspend fun post(path: String, body: JsonElement?) = ApiResult.Failure(ApiError.NotFound)
    override suspend fun put(path: String, body: JsonElement?) = ApiResult.Failure(ApiError.NotFound)
    override suspend fun delete(path: String) = ApiResult.Failure(ApiError.NotFound)
}

/** A lock that opens with the test vector's store key for 914 (no prompt). */
class FakeAppLock(unlocked: Boolean = false, private val keyStores: Set<Int> = setOf(914)) : AppLock {
    private val ring = Keyring()
    override val isUnlocked = MutableStateFlow(false)
    override val remaining = MutableStateFlow<Duration?>(null)
    override val attempt: StateFlow<UnlockAttempt> = MutableStateFlow(UnlockAttempt.Idle)
    var touches = 0
    init { if (unlocked) unlock() }
    override fun unlock() { keyStores.forEach { ring.put(it, TestCrypto.vectorPkcs8()) }; remaining.value = 30.minutes; isUnlocked.value = true }
    override fun lock() { ring.clear(); remaining.value = null; isUnlocked.value = false }
    override fun touch() { touches++ }
    override val opener: SealedOpener? get() = if (isUnlocked.value) ring else null
}
