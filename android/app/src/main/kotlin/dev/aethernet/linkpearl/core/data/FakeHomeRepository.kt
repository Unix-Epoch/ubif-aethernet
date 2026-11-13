package dev.aethernet.linkpearl.core.data

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay

/** The states Home can be in. The fake repository and the screenshot tests use these. */
enum class HomeScenario { OneStore, AllStores, Stale, Offline, Error, Loading }

/** Fake numbers (the approved mockups' data): Fri Nov 13 2026, 4:14 PM, two stores. Deterministic, no clock. */
object FakeHomeData {
    const val NOW = "2026-11-13T21:14:00Z"
    const val TODAY = "2026-11-13"
    private const val TZ = "America/New_York"
    private val DAYS = listOf("2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13")
    private val AGES = listOf("0–2 days", "3–6 days", "7–13 days", "14–29 days", "30+ days")

    val sandbox = StoreRef(999999, "Sandbox Store")
    val lynnhaven = StoreRef(326, "Lynnhaven")
    val stores = listOf(sandbox, lynnhaven)

    private const val SANDBOX_ASOF = "2026-11-13T21:12:00Z" // 4:12 PM
    private const val LYNN_ASOF = "2026-11-13T18:40:00Z" // 1:40 PM, 2h 34m before NOW

    fun oneStore(): HomeData = HomeData(
        now = NOW, tz = TZ, today = TODAY, stores = stores, days = DAYS,
        sales = Sales(today = 2418.0, yesterday = 2096.0, week = listOf(1980.0, 0.0, 2240.0, 1890.0, 2310.0, 2096.0, 2418.0)),
        splh = Splh(today = 172.0, hours = 14.06, week = listOf(158.0, null, 171.0, 149.0, 183.0, 166.0, 172.0)),
        rfp = Rfp(total = 885.0, count = 3, oldestDays = 12, ages = AGES.zip(listOf(0, 1, 2, 0, 0)).map { AgeBucket(it.first, it.second) }),
        lanes = Lanes(order = 2, start = 3, work = 7, wait = 5, rfp = 3, total = 20),
        cleaning = Cleaning(cln = 14, am = 18, rate = 0.78, week = listOf(0.7, null, 0.74, 0.69, 0.8, 0.72, 0.78)),
        asOf = SANDBOX_ASOF,
    )

    /** One store whose scans stopped: the stale banner. */
    fun stale(): HomeData = HomeData(
        now = NOW, tz = TZ, today = TODAY, stores = stores, days = DAYS,
        sales = Sales(today = 1186.0, yesterday = 2030.0, week = listOf(1760.0, 0.0, 1950.0, 1810.0, 2120.0, 2030.0, 1186.0)),
        splh = Splh(today = 167.0, hours = 7.1, week = listOf(152.0, null, 166.0, 160.0, 171.0, 172.0, 167.0)),
        rfp = Rfp(total = 412.0, count = 2, oldestDays = 9, ages = AGES.zip(listOf(0, 1, 1, 0, 0)).map { AgeBucket(it.first, it.second) }),
        lanes = Lanes(order = 1, start = 2, work = 4, wait = 3, rfp = 2, total = 12),
        cleaning = Cleaning(cln = 10, am = 14, rate = 0.71, week = listOf(0.66, null, 0.7, 0.68, 0.74, 0.7, 0.71)),
        asOf = LYNN_ASOF, stale = true,
    )

    fun allStores(): HomeData = HomeData(
        now = NOW, tz = TZ, today = TODAY, stores = stores, days = DAYS,
        sales = Sales(today = 3604.0, yesterday = 4126.0, week = listOf(3740.0, 0.0, 4190.0, 3700.0, 4430.0, 4126.0, 3604.0)),
        splh = Splh(today = 170.0, hours = 21.16, week = listOf(155.0, null, 169.0, 154.0, 178.0, 169.0, 170.0)),
        rfp = Rfp(total = 1297.0, count = 5, oldestDays = 12, ages = AGES.zip(listOf(0, 2, 3, 0, 0)).map { AgeBucket(it.first, it.second) }),
        lanes = Lanes(order = 3, start = 5, work = 11, wait = 8, rfp = 5, total = 32),
        cleaning = Cleaning(cln = 24, am = 32, rate = 0.75, week = listOf(0.69, null, 0.73, 0.69, 0.77, 0.71, 0.75)),
        asOf = LYNN_ASOF, stale = true, behind = lynnhaven.copy(name = "Lynnhaven"),
        byStore = listOf(
            ByStore(sandbox.id, sandbox.name, SANDBOX_ASOF, false, 2418.0, 172.0),
            ByStore(lynnhaven.id, lynnhaven.name, LYNN_ASOF, true, 1186.0, 167.0),
        ),
    )

    /** Data for a scenario ([HomeScenario.Error] and [HomeScenario.Loading] have none). */
    fun forScenario(s: HomeScenario): HomeData? = when (s) {
        HomeScenario.OneStore, HomeScenario.Offline -> oneStore()
        HomeScenario.AllStores -> allStores()
        HomeScenario.Stale -> stale()
        HomeScenario.Error, HomeScenario.Loading -> null
    }

    /** A one-store answer is for [scope] when it is a single store. */
    fun forScope(scope: StoreScope): HomeData = when (scope) {
        StoreScope.All -> allStores()
        is StoreScope.One -> if (scope.id == lynnhaven.id) stale() else oneStore()
    }
}

/**
 * Returns mock data. [scenario] picks the state; by default the answer follows the chosen scope (All stores / Sandbox / Lynnhaven stale).
 * Loading never answers. Replace with the real repository in `DataModule` (agent A).
 */
class FakeHomeRepository(
    private val scenario: (StoreScope) -> HomeScenario? = { null },
    private val latencyMs: Long = 400,
) : HomeRepository {
    override suspend fun load(scope: StoreScope, fresh: Boolean): HomeResult {
        val s = scenario(scope)
        if (latencyMs > 0) delay(latencyMs)
        return when (s) {
            HomeScenario.Loading -> { CompletableDeferred<Unit>().await(); HomeResult.Failed(FailureReason.Server) }
            HomeScenario.Error -> HomeResult.Failed(FailureReason.Server)
            HomeScenario.Offline -> HomeResult.Ok(FakeHomeData.forScope(scope), cached = true)
            null -> HomeResult.Ok(FakeHomeData.forScope(scope))
            else -> HomeResult.Ok(FakeHomeData.forScenario(s)!!)
        }
    }
}
