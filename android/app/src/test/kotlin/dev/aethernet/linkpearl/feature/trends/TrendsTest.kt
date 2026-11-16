package dev.aethernet.linkpearl.feature.trends

import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.data.LinkpearlJson
import dev.aethernet.linkpearl.core.data.StoreScope
import dev.aethernet.linkpearl.core.lock.TestAuth
import dev.aethernet.linkpearl.feature.alerts.FakeApi
import dev.aethernet.linkpearl.feature.workorders.LoadView
import dev.aethernet.linkpearl.feature.workorders.Problem
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.LocalDate

/** Trends: parsing of the documented answer, the calendar maths and words, the repository's query, and the view model. */
@OptIn(ExperimentalCoroutinesApi::class)
class TrendsTest {
    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    /** The example in tracker-worker/MOBILE-API-trends.md (invented numbers), with one key the app does not know. */
    private val DOC = """{"v":1,"period":"week","scope":"all","tz":"America/New_York","today":"2026-11-16","future":"ignored",
 "from":"2026-10-11","to":"2026-10-17","prevFrom":"2026-10-04","prevTo":"2026-10-10","prevThrough":"2026-10-10",
 "asOf":"2026-10-15T19:10:00.000Z",
 "sales":{"total":380,"prevTotal":1179,"changePct":-67.8,
   "days":[{"day":"2026-10-11","value":null},{"day":"2026-10-12","value":200},{"day":"2026-10-13","value":120},{"day":"2026-10-14","value":null},{"day":"2026-10-15","value":60},{"day":"2026-10-16","value":null},{"day":"2026-10-17","value":null}],
   "prevDays":[{"day":"2026-10-04","value":null},{"day":"2026-10-05","value":100},{"day":"2026-10-06","value":50},{"day":"2026-10-07","value":null},{"day":"2026-10-08","value":30},{"day":"2026-10-09","value":999},{"day":"2026-10-10","value":null}]},
 "splh":{"value":15.79,"prev":50,"hours":19,"target":{"lo":160,"hi":180},
   "days":[{"day":"2026-10-11","value":null},{"day":"2026-10-12","value":20},{"day":"2026-10-13","value":8},{"day":"2026-10-14","value":null},{"day":"2026-10-15","value":15},{"day":"2026-10-16","value":null},{"day":"2026-10-17","value":null}]},
 "cleaning":{"linked":6,"orders":10,"pct":60,"prevPct":28.6},
 "rfp":{"total":30,"count":1,"prevTotal":null},
 "stores":[{"id":914,"name":"Newport News","sales":340,"prevSales":1179,"changePct":-71.2,"splh":18.57,"hours":14},
           {"id":326,"name":"Lynnhaven","sales":40,"prevSales":null,"changePct":null,"splh":8,"hours":5}]}"""

    private fun parse(s: String) = LinkpearlJson.decodeFromString(TrendsData.serializer(), s)

    @Test fun parsesTheDocumentedAnswer() {
        val d = parse(DOC)
        assertEquals("2026-10-11", d.from); assertEquals("2026-10-10", d.prevThrough)
        assertEquals(380.0, d.sales!!.total); assertEquals(-67.8, d.sales!!.changePct); assertNull(d.sales!!.days[0].value); assertEquals(7, d.sales!!.prevDays.size)
        assertEquals(160.0, d.splh!!.target!!.lo, 0.0); assertEquals(19.0, d.splh!!.hours)
        assertEquals(60.0, d.cleaning!!.pct); assertNull(d.rfp!!.prevTotal)
        assertEquals("Newport News #914", d.stores!![0].label); assertNull(d.stores!![1].changePct)
    }

    @Test fun missingPartsAreNullAndEmptyIsKept() {
        val d = parse("""{"v":1,"stores":[],"empty":true}""")
        assertTrue(d.empty); assertNull(d.sales); assertNull(d.splh); assertTrue(d.stores!!.isEmpty())
        val sparse = parse("""{"period":"month","sales":{"total":null}}""")
        assertNull(sparse.sales!!.total); assertTrue(sparse.sales!!.days.isEmpty()); assertNull(sparse.today)
    }

    @Test fun weeksRunSundayToSaturday() {
        assertEquals(LocalDate.of(2026, 11, 15) to LocalDate.of(2026, 11, 21), TrendsFmt.range(TrendPeriod.Week, LocalDate.of(2026, 11, 16)))
        assertEquals(LocalDate.of(2026, 11, 15) to LocalDate.of(2026, 11, 21), TrendsFmt.range(TrendPeriod.Week, LocalDate.of(2026, 11, 15)))
        assertEquals(LocalDate.of(2026, 11, 8) to LocalDate.of(2026, 11, 14), TrendsFmt.range(TrendPeriod.Week, LocalDate.of(2026, 11, 14)))
        assertEquals(LocalDate.of(2026, 2, 1) to LocalDate.of(2026, 2, 28), TrendsFmt.range(TrendPeriod.Month, LocalDate.of(2026, 2, 17)))
        assertEquals(LocalDate.of(2026, 1, 1) to LocalDate.of(2026, 12, 31), TrendsFmt.range(TrendPeriod.Year, LocalDate.of(2026, 6, 1)))
    }

    @Test fun periodLabels() {
        val today = LocalDate.of(2026, 11, 13)
        fun w(a: String, b: String) = TrendsFmt.periodLabel(TrendPeriod.Week, LocalDate.parse(a), LocalDate.parse(b), today)
        assertEquals("Nov 8–14", w("2026-11-08", "2026-11-14"))
        assertEquals("Oct 25–31", w("2026-10-25", "2026-10-31"))
        assertEquals("Nov 29–Dec 5", w("2026-11-29", "2026-12-05"))
        assertEquals("Dec 28–Jan 3", TrendsFmt.periodLabel(TrendPeriod.Week, LocalDate.parse("2025-12-28"), LocalDate.parse("2026-01-03"), today))
        assertEquals("Dec 21–27, 2025", w("2025-12-21", "2025-12-27"))
        assertEquals("November", TrendsFmt.periodLabel(TrendPeriod.Month, LocalDate.parse("2026-11-01"), LocalDate.parse("2026-11-30"), today))
        assertEquals("November 2025", TrendsFmt.periodLabel(TrendPeriod.Month, LocalDate.parse("2025-11-01"), LocalDate.parse("2025-11-30"), today))
        assertEquals("2025", TrendsFmt.periodLabel(TrendPeriod.Year, LocalDate.parse("2025-01-01"), LocalDate.parse("2025-12-31"), today))
    }

    @Test fun comparisonWords() {
        assertEquals("Last week by Fri", TrendsFmt.compareLabel(TrendPeriod.Week, FakeTrends.week()))
        assertEquals("October by the 13th", TrendsFmt.compareLabel(TrendPeriod.Month, FakeTrends.month()))
        assertEquals("2025 by Nov 13", TrendsFmt.compareLabel(TrendPeriod.Year, FakeTrends.year()))
        // A week that is over: the whole week before.
        assertEquals("Week before", TrendsFmt.compareLabel(TrendPeriod.Week, parse(DOC)))
        val over = FakeTrends.month().copy(today = "2026-12-02", prevThrough = "2026-10-31")
        assertEquals("October", TrendsFmt.compareLabel(TrendPeriod.Month, over))
        assertEquals("by the 1st", TrendsFmt.compareLabel(TrendPeriod.Month, FakeTrends.month().copy(prevThrough = "2026-10-01")).removePrefix("October "))
        assertEquals("by the 22nd", TrendsFmt.compareLabel(TrendPeriod.Month, FakeTrends.month().copy(prevThrough = "2026-10-22")).removePrefix("October "))
        assertEquals("by the 11th", TrendsFmt.compareLabel(TrendPeriod.Month, FakeTrends.month().copy(prevThrough = "2026-10-11")).removePrefix("October "))
    }

    @Test fun chartSeriesStopAtTodayAndRunningTotalsSkipNulls() {
        val w = FakeTrends.week()
        assertEquals(6, TrendsFmt.elapsed(TrendPeriod.Week, w.sales!!.days, w.today))
        assertEquals(7, TrendsFmt.elapsed(TrendPeriod.Week, w.sales!!.days, null))
        val y = FakeTrends.year()
        assertEquals(11, TrendsFmt.elapsed(TrendPeriod.Year, y.sales!!.days, y.today))
        assertEquals(listOf(0.0, 200.0, 320.0, 320.0, 380.0), TrendsFmt.cumulative(listOf(null, 200.0, 120.0, null, 60.0)))
        assertEquals(14860.0, TrendsFmt.cumulative(w.sales!!.days.take(6).map { it.value }).last(), 0.001)
        assertEquals(13742.0, TrendsFmt.cumulative(w.sales!!.prevDays.take(6).map { it.value }).last(), 0.001)
    }

    @Test fun axisAndChangeWords() {
        assertEquals(listOf("S", "M", "T", "W", "T", "F", "S"), TrendsFmt.axis(TrendPeriod.Week, FakeTrends.week().sales!!.days))
        assertEquals(listOf("Nov 1", "15", "30"), TrendsFmt.axis(TrendPeriod.Month, FakeTrends.month().sales!!.days))
        assertEquals("JFMAMJJASOND", TrendsFmt.axis(TrendPeriod.Year, FakeTrends.year().sales!!.days).joinToString(""))
        assertEquals("Fri Nov 13", TrendsFmt.bucketName(TrendPeriod.Week, "2026-11-13")); assertEquals("Mar", TrendsFmt.bucketName(TrendPeriod.Year, "2026-03"))
        assertEquals(Direction.Up, TrendsFmt.direction(8.1)); assertEquals(Direction.Down, TrendsFmt.direction(-2.0))
        assertEquals(Direction.Flat, TrendsFmt.direction(0.4)); assertNull(TrendsFmt.direction(null))
        assertEquals("8%", TrendsFmt.pct(8.1)); assertEquals("68%", TrendsFmt.pct(-67.8)); assertEquals("—", TrendsFmt.pct(null))
        assertEquals("4 pts", TrendsFmt.points(4.1)); assertEquals("1 pt", TrendsFmt.points(-1.2)); assertEquals("76%", TrendsFmt.percentValue(76.1))
    }

    @Test fun repositoryAsksWithStorePeriodDayAndFresh() = runBlocking {
        val api = FakeApi { _, _, _, _ -> ApiResult.Success(LinkpearlJson.parseToJsonElement(DOC)) }
        val r = RealTrendsRepository(api).load(StoreScope.One(914), TrendPeriod.Month, "2026-10-31", fresh = true)
        assertEquals(380.0, (r as ApiResult.Success).value.sales!!.total)
        assertEquals(listOf("GET", "/v1/agents/m/trends", mapOf("store" to "914", "period" to "month", "at" to "2026-10-31", "fresh" to "1"), null), api.calls.single())
        RealTrendsRepository(api).load(StoreScope.All, TrendPeriod.Week, null)
        assertEquals(mapOf("store" to "all", "period" to "week"), api.calls.last()[2])
    }

    @Test fun repositoryFailures() = runBlocking {
        val missing = RealTrendsRepository(FakeApi { _, _, _, _ -> ApiResult.Failure(ApiError.NotFound, 404) }).load(StoreScope.All, TrendPeriod.Week, null)
        assertEquals(ApiError.Server, (missing as ApiResult.Failure).error)
        val bad = RealTrendsRepository(FakeApi { _, _, _, _ -> ApiResult.Success(LinkpearlJson.parseToJsonElement("[1,2]")) }).load(StoreScope.All, TrendPeriod.Week, null)
        assertEquals(ApiError.Server, (bad as ApiResult.Failure).error)
    }

    // ---- view model ---------------------------------------------------------------------------------------------------------

    private fun vm(repo: FakeTrendsRepository = FakeTrendsRepository(), scope: StoreScope = StoreScope.One(999999)) =
        TrendsViewModel(repo, TestAuth(), scope, today = { LocalDate.of(2026, 11, 13) })

    @Test fun opensOnHomesStoreAndTheCurrentWeek() {
        val repo = FakeTrendsRepository()
        val s = vm(repo).state.value
        assertEquals(Triple(StoreScope.One(999999), TrendPeriod.Week, null), repo.calls.single())
        assertEquals(LoadView.Ok, s.view); assertEquals("Nov 8–14", s.periodLabel)
        assertFalse("the current week has no next", s.canNext); assertTrue(s.canPrev)
        assertEquals(listOf(914, 326), s.stores.map { it.id })
    }

    @Test fun pagesBackWithTheDayBeforeFromAndForwardToTheCurrentPeriod() {
        val repo = FakeTrendsRepository()
        val m = vm(repo)
        m.previous()
        assertEquals("2026-11-07", repo.calls.last().third)
        // The fake answers the current week whatever is asked, so the label follows the asked day, worked out on the phone.
        repo.answer = { _, _, at -> ApiResult.Success(FakeTrends.week().copy(from = "2026-11-01", to = "2026-11-07", prevFrom = "2026-10-25", prevTo = "2026-10-31", prevThrough = "2026-10-31")) }
        m.refresh()
        assertEquals("Nov 1–7", m.state.value.periodLabel); assertTrue(m.state.value.canNext)
        m.previous(); assertEquals("2026-10-31", repo.calls.last().third)
        repo.answer = null
        m.next(); assertEquals("2026-11-01", repo.calls.last().third)
        m.next(); assertNull("back to the current week: no at", repo.calls.last().third)
        assertFalse(m.state.value.canNext)
        val n = repo.calls.size
        m.next(); assertEquals("next at the current period does nothing", n, repo.calls.size)
    }

    @Test fun periodAndStoreChangesReload() {
        val repo = FakeTrendsRepository()
        val m = vm(repo)
        m.previous()
        m.pickPeriod(TrendPeriod.Month)
        assertEquals(Triple(StoreScope.One(999999), TrendPeriod.Month, null), repo.calls.last())
        assertEquals("November", m.state.value.periodLabel)
        m.pickScope(StoreScope.All)
        assertEquals(StoreScope.All, repo.calls.last().first)
        assertEquals(2, m.state.value.data!!.stores!!.size)
        val n = repo.calls.size
        m.pickScope(StoreScope.All); assertEquals(n, repo.calls.size)
    }

    @Test fun refreshIsFreshAndAFailureKeepsTheNumbers() {
        val repo = FakeTrendsRepository()
        val m = vm(repo)
        repo.answer = { _, _, _ -> ApiResult.Failure(ApiError.Offline) }
        m.refresh()
        assertTrue(repo.fresh.last())
        assertEquals(LoadView.Ok, m.state.value.view); assertEquals(Problem.Offline, m.state.value.problem); assertEquals(14860.0, m.state.value.data!!.sales!!.total)
        m.pickPeriod(TrendPeriod.Year)
        assertEquals(LoadView.Error, m.state.value.view); assertEquals(Problem.Offline, m.state.value.problem)
        repo.answer = { _, _, _ -> ApiResult.Failure(ApiError.NotFound, 404) }
        m.refresh()
        assertEquals(Problem.Server, m.state.value.problem)
    }

    @Test fun aPeriodSeenBeforeShowsAtOnce() {
        val repo = FakeTrendsRepository()
        val m = vm(repo)
        m.pickPeriod(TrendPeriod.Month)
        repo.answer = { _, _, _ -> ApiResult.Failure(ApiError.Offline) }
        m.pickPeriod(TrendPeriod.Week)
        assertEquals(LoadView.Ok, m.state.value.view); assertEquals(14860.0, m.state.value.data!!.sales!!.total)
    }
}
