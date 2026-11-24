package dev.aethernet.linkpearl.feature.trends

import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.data.StoreScope

/** Answers from [FakeTrends] (or [answer] when given). Records every call. */
class FakeTrendsRepository(var answer: ((StoreScope, TrendPeriod, String?) -> ApiResult<TrendsData>)? = null) : TrendsRepository {
    val calls = mutableListOf<Triple<StoreScope, TrendPeriod, String?>>()
    val fresh = mutableListOf<Boolean>()
    override suspend fun load(scope: StoreScope, period: TrendPeriod, at: String?, fresh: Boolean): ApiResult<TrendsData> {
        calls += Triple(scope, period, at); this.fresh += fresh
        return answer?.invoke(scope, period, at) ?: ApiResult.Success(FakeTrends.forScope(scope, period))
    }
}

/** Invented numbers in the shape of the approved mockups: Fri Nov 13 2026, stores Sandbox #999999 and Lynnhaven #326. */
object FakeTrends {
    const val TODAY = "2026-11-13"
    private const val TZ = "America/New_York"
    private const val AS_OF = "2026-11-13T21:12:00Z"

    private fun days(from: String, values: List<Double?>): List<TrendPoint> {
        val start = java.time.LocalDate.parse(from)
        return values.mapIndexed { i, v -> TrendPoint(start.plusDays(i.toLong()).toString(), v) }
    }

    fun forScope(scope: StoreScope, period: TrendPeriod): TrendsData = when (period) {
        TrendPeriod.Week -> week(scope)
        TrendPeriod.Month -> month(scope)
        TrendPeriod.Year -> year(scope)
    }

    private val sandboxRow = TrendStore(999999, "Sandbox", sales = 24610.0, prevSales = 22790.0, changePct = 8.0, splh = 174.0, hours = 141.4)
    private val lynnRow = TrendStore(326, "Lynnhaven", sales = 16620.0, prevSales = 16960.0, changePct = -2.0, splh = 151.0, hours = 110.1)

    fun week(scope: StoreScope = StoreScope.One(999999)): TrendsData = TrendsData(
        period = "week", tz = TZ, today = TODAY, from = "2026-11-08", to = "2026-11-14", prevFrom = "2026-11-01", prevTo = "2026-11-07", prevThrough = "2026-11-06",
        asOf = AS_OF,
        sales = TrendSales(
            total = 14860.0, prevTotal = 13742.0, changePct = 8.1,
            days = days("2026-11-08", listOf(1290.0, 2610.0, 2480.0, 2390.0, 2672.0, 3418.0, null)),
            prevDays = days("2026-11-01", listOf(1180.0, 2420.0, 2310.0, 2350.0, 2402.0, 3080.0, 2250.0)),
        ),
        splh = TrendSplh(value = 172.0, prev = 161.0, hours = 86.4, target = TrendTarget(160.0, 180.0),
            days = days("2026-11-08", listOf(158.0, null, 171.0, 149.0, 183.0, 166.0, null))),
        cleaning = TrendCleaning(linked = 86, orders = 113, pct = 76.1, prevPct = 72.0),
        rfp = TrendRfp(total = 885.0, count = 3, prevTotal = 1095.0),
        stores = if (scope == StoreScope.All) listOf(sandboxRow.copy(sales = 8740.0, prevSales = 8020.0, changePct = 9.0, splh = 176.0), lynnRow.copy(sales = 6120.0, prevSales = 5722.0, changePct = 7.0, splh = 157.0)) else null,
    )

    fun month(scope: StoreScope = StoreScope.All): TrendsData {
        val cur = listOf(1210.0, 1420.0, 1380.0, 1460.0, 1530.0, 1390.0, 1480.0, 1350.0, 1510.0, 1440.0, 1560.0, 1490.0, 1620.0) + List(17) { null }
        val prev = listOf(1150.0, 1380.0, 1300.0, 1420.0, 1490.0, 1350.0, 1400.0, 1330.0, 1440.0, 1410.0, 1470.0, 1450.0, 1520.0, 1480.0, 1530.0,
            1460.0, 1510.0, 1390.0, 1550.0, 1490.0, 1420.0, 1580.0, 1600.0, 1530.0, 1470.0, 1610.0, 1560.0, 1500.0, 1640.0, 1590.0, 1620.0)
        return TrendsData(
            period = "month", tz = TZ, today = TODAY, from = "2026-11-01", to = "2026-11-30", prevFrom = "2026-10-01", prevTo = "2026-10-31", prevThrough = "2026-10-13",
            asOf = AS_OF,
            sales = TrendSales(total = 41230.0, prevTotal = 39180.0, changePct = 5.2, days = days("2026-11-01", cur), prevDays = days("2026-10-01", prev)),
            splh = TrendSplh(value = 165.0, prev = 158.0, hours = 251.5, target = TrendTarget(), days = days("2026-11-01", listOf(158.0, null, 171.0, 149.0, 183.0, 166.0, 172.0, 160.0, 168.0, 155.0, 170.0, 162.0, 174.0) + List(17) { null })),
            cleaning = TrendCleaning(linked = 212, orders = 287, pct = 73.9, prevPct = 75.2),
            rfp = TrendRfp(total = 1540.0, count = 6, prevTotal = 1210.0),
            stores = if (scope == StoreScope.All) listOf(sandboxRow, lynnRow) else null,
        )
    }

    fun year(scope: StoreScope = StoreScope.All): TrendsData {
        val months = (1..12).map { "2026-%02d".format(it) }
        val prevMonths = (1..12).map { "2025-%02d".format(it) }
        val cur = listOf(38200.0, 36100.0, 41800.0, 40200.0, 42900.0, 44100.0, 45300.0, 43800.0, 41200.0, 43900.0, 41230.0, null)
        val prev = listOf(35100.0, 34800.0, 38900.0, 39100.0, 40800.0, 42200.0, 43100.0, 42600.0, 39800.0, 41700.0, 40900.0, 46200.0)
        return TrendsData(
            period = "year", tz = TZ, today = TODAY, from = "2026-01-01", to = "2026-12-31", prevFrom = "2025-01-01", prevTo = "2025-12-31", prevThrough = "2025-11-13",
            asOf = AS_OF,
            sales = TrendSales(total = 458730.0, prevTotal = 430110.0, changePct = 6.7, days = months.zip(cur) { d, v -> TrendPoint(d, v) }, prevDays = prevMonths.zip(prev) { d, v -> TrendPoint(d, v) }),
            splh = TrendSplh(value = 168.0, prev = 163.0, hours = 2730.5, target = TrendTarget(), days = months.zip(listOf(161.0, 158.0, 166.0, 170.0, 171.0, 169.0, 175.0, 172.0, 160.0, 167.0, 165.0, null)) { d, v -> TrendPoint(d, v) }),
            cleaning = TrendCleaning(linked = 2410, orders = 3180, pct = 75.8, prevPct = 70.1),
            rfp = TrendRfp(total = 1540.0, count = 6, prevTotal = null),
            stores = if (scope == StoreScope.All) listOf(sandboxRow.copy(sales = 271400.0, prevSales = 250300.0, changePct = 8.4, splh = 172.0), lynnRow.copy(sales = 187330.0, prevSales = 179810.0, changePct = 4.2, splh = 162.0)) else null,
        )
    }
}
