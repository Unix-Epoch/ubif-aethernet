package dev.aethernet.linkpearl.feature.workorders

import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.lock.TestAuth
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.LocalDate

/** Waymark from the phone (MOBILE-API-waymark.md): the date rules, the error lines, and the detail's tag and follow-up changes. */
@OptIn(ExperimentalCoroutinesApi::class)
class WoWaymarkEditTest {
    private val main = UnconfinedTestDispatcher()
    @Before fun setUp() = Dispatchers.setMain(main)
    @After fun tearDown() = Dispatchers.resetMain()

    private val api = FakeApi()
    private val repo = WoRepository(api)
    private fun vm() = WorkOrderDetailViewModel(repo, FakeAppLock(), TestAuth(), nowMs = { 0L }, work = main)

    private val key = WoKey(914, 7000003)
    private val detailPath = "/v1/agents/m/wo/914/7000003"
    private val isTag = { p: String, _: JsonElement? -> p == "/v1/agents/m/waymark/tag" }
    private val isFollow = { p: String, _: JsonElement? -> p == "/v1/agents/m/waymark/followup" }

    /** The doc's tag sheet answer. */
    private val tagsJson = """{"v":1,"store":914,"tags":[{"name":"Priority","color":"red"},{"name":"Waiting on customer","color":"orange"},{"name":"Parts","color":"blue"}],"oneOff":true,"maxTags":12,"maxLength":32}"""

    private fun detailWith(tags: String = """[{"tag":"Priority","color":"red"}]""", followUp: String = """{"kind":"rfp","due":"2026-11-12"}""") =
        WoWaymarkFixtures.DETAIL_OPEN_WAYMARK.replace(""""tags":[{"tag":"Priority","color":"red"}]""", """"tags":$tags""")
            .replace(""""followUp":{"kind":"rfp","due":"2026-11-12"}""", """"followUp":$followUp""")

    private fun opened(): WorkOrderDetailViewModel {
        api.on({ p, _ -> p == detailPath }, WoWaymarkFixtures.DETAIL_OPEN_WAYMARK)
        api.on({ p, q -> p == "/v1/agents/m/waymark/tags" && q["store"] == "914" }, tagsJson)
        return vm().also { it.show(key) }
    }

    private fun JsonElement?.field(name: String) = (this as JsonObject)[name].toString().trim('"')

    // ---- pure ------------------------------------------------------------------------------------------------------------------

    @Test fun pushesAreAlwaysLaterThanTheDueAndToday() {
        val today = LocalDate.parse("2026-11-15")
        val overdue = LocalDate.parse("2026-11-10")
        assertEquals(LocalDate.parse("2026-11-16"), FollowUpDates.push(today, overdue, 1))
        assertEquals(LocalDate.parse("2026-11-18"), FollowUpDates.push(today, overdue, 3))
        assertEquals(LocalDate.parse("2026-11-22"), FollowUpDates.push(today, overdue, 7))
        val later = LocalDate.parse("2026-11-20")
        assertEquals("from the due when it is later than today", LocalDate.parse("2026-11-21"), FollowUpDates.push(today, later, 1))
        assertEquals("today is after an overdue day", today, FollowUpDates.earliest(today, overdue))
        assertEquals(LocalDate.parse("2026-11-21"), FollowUpDates.earliest(today, later))
        assertEquals(LocalDate.parse("2027-11-15"), FollowUpDates.latest(today))
        assertTrue(FollowUpDates.allowed(LocalDate.parse("2027-11-15"), today, later))
        assertFalse("over a year", FollowUpDates.allowed(LocalDate.parse("2027-11-16"), today, later))
        assertFalse("not after the due", FollowUpDates.allowed(later, today, later))
        assertFalse("in the past", FollowUpDates.allowed(LocalDate.parse("2026-11-14"), today, overdue))
    }

    @Test fun labels() {
        val today = LocalDate.parse("2026-11-15")
        assertEquals("Overdue · Nov 10", FollowUpDates.stateLabel(LocalDate.parse("2026-11-10"), today))
        assertEquals("Due today", FollowUpDates.stateLabel(today, today))
        assertEquals("Nov 18", FollowUpDates.stateLabel(LocalDate.parse("2026-11-18"), today))
        assertEquals("Mon, Nov 16", FollowUpDates.dayLabel(LocalDate.parse("2026-11-16")))
        assertEquals(listOf("+1 day", "+3 days", "+7 days"), FollowUpDates.QUICK.map(FollowUpDates::quickLabel))
    }

    @Test fun tagCleaningAndSheetRows() {
        assertEquals("Call back after 3", WaymarkTags.clean("  Call   back\u0007 after 3 "))
        assertEquals(32, WaymarkTags.clean("x".repeat(40)).length)
        val rows = WaymarkTags.rows(listOf(ManagedTag("Priority", "red"), ManagedTag("Parts", "blue")), listOf(WoTag("priority", "red"), WoTag("Left voicemail", null)))
        assertEquals(listOf("Priority", "Parts", "Left voicemail"), rows.map { it.name })
        assertEquals(listOf(true, false, true), rows.map { it.on })
        assertNull("a one-off has no colour", rows[2].color)
    }

    @Test fun errorLines() {
        fun f(status: Int, error: ApiError, msg: String?) = waymarkErrorText(ApiResult.Failure(error, status, msg))
        assertEquals("Changed elsewhere. Reload.", f(409, ApiError.Server, "the follow-up changed meanwhile, reload it"))
        assertEquals("Work order is closed.", f(409, ApiError.Server, "work order is closed"))
        assertEquals("Too many changes. Try later.", f(429, ApiError.RateLimited, "too many Waymark changes from this phone, try again later"))
        assertEquals("12 tags at most.", f(400, ApiError.Server, "too many tags on this work order"))
        assertEquals("Pick a later date.", f(400, ApiError.Server, "follow-ups can only move later"))
        assertEquals("At most a year ahead.", f(400, ApiError.Server, "due: at most a year ahead"))
        assertEquals("No follow-up to change.", f(404, ApiError.NotFound, "no follow-up on this work order"))
        assertEquals("No Aethernet access.", f(403, ApiError.Forbidden, "this store does not have access to Aethernet"))
        assertEquals("Not your store.", f(403, ApiError.Forbidden, "not your store"))
        assertEquals("Offline. Not saved.", waymarkErrorText(ApiResult.Failure(ApiError.Offline)))
        assertEquals("Couldn't save.", f(500, ApiError.Server, null))
    }

    // ---- tags ------------------------------------------------------------------------------------------------------------------

    @Test fun tagSheetLoadsTheStoresList() = runTest {
        val vm = opened()
        assertTrue(vm.state.value.editable)
        vm.openTags()
        val sheet = vm.state.value.tagsSheet!!
        assertFalse(sheet.loading)
        assertEquals(listOf("Priority", "Waiting on customer", "Parts"), sheet.managed!!.map { it.name })
        assertEquals(12, sheet.maxTags)
        vm.closeTags()
        assertNull(vm.state.value.tagsSheet)
    }

    @Test fun tagSheetFailureCanRetry() = runTest {
        api.on({ p, _ -> p == detailPath }, WoWaymarkFixtures.DETAIL_OPEN_WAYMARK)
        api.fail({ p, _ -> p.endsWith("/waymark/tags") }, ApiResult.Failure(ApiError.Offline))
        val vm = vm().also { it.show(key) }
        vm.openTags()
        assertTrue(vm.state.value.tagsSheet!!.failed)
        api.on({ p, _ -> p.endsWith("/waymark/tags") }, tagsJson)
        vm.openTags()
        assertFalse(vm.state.value.tagsSheet!!.failed)
        assertEquals(3, vm.state.value.tagsSheet!!.managed!!.size)
    }

    @Test fun tagOnSendsTheManagedNameUpdatesAndTellsTheList() = runTest {
        val vm = opened()
        vm.openTags()
        val changed = mutableListOf<WoRow>()
        val collector = CoroutineScope(main).launchCollect(repo) { changed += it }
        api.onPost(isTag, """{"ok":true,"store":914,"wo":7000003,"tag":"Parts","on":true,"changed":true,"tags":[{"tag":"Priority","color":"red"},{"tag":"Parts","color":"blue"}]}""")
        api.on({ p, _ -> p == detailPath }, detailWith(tags = """[{"tag":"Priority","color":"red"},{"tag":"Parts","color":"blue"}]"""))
        val before = api.calls.size
        vm.toggleTag("parts", true)
        val body = api.posts.single().second
        assertEquals("914", body.field("store")); assertEquals("7000003", body.field("wo")); assertEquals("Parts", body.field("tag")); assertEquals("true", body.field("on"))
        assertEquals(listOf("Priority", "Parts"), vm.state.value.detail!!.wo.tags.map { it.tag })
        assertTrue("busy cleared", vm.state.value.tagsSheet!!.busy.isEmpty())
        assertTrue("the detail is read again", api.calls.drop(before).any { it.first == detailPath })
        assertEquals(listOf("Priority", "Parts"), changed.single().tags.map { it.tag })
        collector.cancel()
    }

    @Test fun tagOffFailureRollsBackWithALine() = runTest {
        val vm = opened()
        vm.openTags()
        api.failPost(isTag, ApiResult.Failure(ApiError.RateLimited, 429, "too many Waymark changes from this phone, try again later"))
        vm.toggleTag("Priority", false)
        assertEquals("false", api.posts.single().second.field("on"))
        assertEquals("put back", listOf("Priority"), vm.state.value.detail!!.wo.tags.map { it.tag })
        assertEquals("Too many changes. Try later.", vm.state.value.message)
        vm.messageShown()
        assertNull(vm.state.value.message)
    }

    @Test fun tagOnFailureTakesTheOptimisticTagOff() = runTest {
        val vm = opened()
        vm.openTags()
        api.failPost(isTag, ApiResult.Failure(ApiError.Server, 409, "work order is closed"))
        vm.toggleTag("Parts", true)
        assertEquals(listOf("Priority"), vm.state.value.detail!!.wo.tags.map { it.tag })
        assertEquals("Work order is closed.", vm.state.value.message)
    }

    @Test fun oneOffTagIsCleanedAndTheLimitIsCheckedFirst() = runTest {
        val vm = opened()
        vm.openTags()
        api.onPost(isTag, """{"ok":true,"store":914,"wo":7000003,"tag":"Left voicemail","on":true,"changed":true,"tags":[{"tag":"Priority","color":"red"},{"tag":"Left voicemail","color":null}]}""")
        vm.addTag("  Left   voicemail ")
        assertEquals("Left voicemail", api.posts.single().second.field("tag"))
        vm.addTag("   ")
        assertEquals("blank: nothing sent", 1, api.posts.size)

        val full = (1..12).joinToString(",", "[", "]") { """{"tag":"T$it","color":null}""" }
        api.on({ p, _ -> p == detailPath }, detailWith(tags = full))
        vm.refresh()
        vm.toggleTag("Parts", true)
        assertEquals("12 tags at most.", vm.state.value.message)
        assertEquals("nothing sent past the limit", 1, api.posts.size)
    }

    // ---- follow-up -------------------------------------------------------------------------------------------------------------

    @Test fun followUpPushSendsThePickedDay() = runTest {
        val vm = opened()
        vm.openFollowUp()
        vm.saveFollowUp()
        assertTrue("nothing picked: nothing sent", api.posts.isEmpty())
        api.onPost(isFollow, """{"ok":true,"store":914,"wo":7000003,"followUp":{"kind":"rfp","due":"2026-11-19"}}""")
        api.on({ p, _ -> p == detailPath }, detailWith(followUp = """{"kind":"rfp","due":"2026-11-19"}"""))
        vm.pickFollowUp(LocalDate.parse("2026-11-19"))
        assertEquals(LocalDate.parse("2026-11-19"), vm.state.value.followSheet!!.choice)
        vm.saveFollowUp()
        val body = api.posts.single().second
        assertEquals("2026-11-19", body.field("due")); assertEquals("7000003", body.field("wo"))
        assertNull("sheet closed", vm.state.value.followSheet)
        assertEquals("2026-11-19", vm.state.value.detail!!.wo.followUp!!.due)
    }

    @Test fun removeAsksOnceThenRemoves() = runTest {
        val vm = opened()
        vm.openFollowUp()
        api.onPost(isFollow, """{"ok":true,"store":914,"wo":7000003,"followUp":null}""")
        api.on({ p, _ -> p == detailPath }, detailWith(followUp = "null"))
        vm.removeFollowUp()
        assertTrue(vm.state.value.followSheet!!.confirmRemove)
        assertTrue("first tap only arms it", api.posts.isEmpty())
        vm.removeFollowUp()
        assertEquals("true", api.posts.single().second.field("remove"))
        assertNull(vm.state.value.detail!!.wo.followUp)
        assertNull(vm.state.value.followSheet)
        vm.openFollowUp()
        assertNull("no follow-up: no sheet (the phone cannot create one)", vm.state.value.followSheet)
    }

    @Test fun followUpChangedElsewhereReloads() = runTest {
        val vm = opened()
        vm.openFollowUp()
        vm.pickFollowUp(LocalDate.parse("2026-11-19"))
        api.failPost(isFollow, ApiResult.Failure(ApiError.Server, 409, "the follow-up changed meanwhile, reload it"))
        val before = api.calls.size
        vm.saveFollowUp()
        assertEquals("Changed elsewhere. Reload.", vm.state.value.message)
        assertFalse(vm.state.value.followSheet!!.saving)
        assertTrue(api.calls.drop(before).any { it.first == detailPath })
    }

    @Test fun closedWorkOrderCannotBeChanged() = runTest {
        api.on({ p, _ -> p == "/v1/agents/m/wo/914/7000010" }, WoWaymarkFixtures.DETAIL_CLOSED)
        val vm = vm().also { it.show(WoKey(914, 7000010)) }
        assertFalse(vm.state.value.editable)
        vm.openTags(); vm.openFollowUp(); vm.toggleTag("Parts", true)
        assertNull(vm.state.value.tagsSheet)
        assertNull(vm.state.value.followSheet)
        assertTrue(api.posts.isEmpty())
    }
}

private fun CoroutineScope.launchCollect(repo: WoRepository, onRow: (WoRow) -> Unit) =
    launch(start = CoroutineStart.UNDISPATCHED) { repo.changed.collect { onRow(it) } }
