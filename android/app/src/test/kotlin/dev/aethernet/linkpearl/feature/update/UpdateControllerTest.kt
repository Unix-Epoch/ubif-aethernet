package dev.aethernet.linkpearl.feature.update

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

@OptIn(ExperimentalCoroutinesApi::class)
class UpdateControllerTest {
    @get:Rule val tmp = TemporaryFolder()

    private var now = 1_000_000_000L
    private val hours = 3_600_000L

    private fun TestScope.controller(
        source: FakeUpdateSource = FakeUpdateSource(UpdateAnswer(Release120, MinVersion(1, "1.0.0"))),
        downloader: FakeDownloader = FakeDownloader(ApkBytes),
        installer: FakeInstaller = FakeInstaller(),
        store: MemoryUpdateStore = MemoryUpdateStore(),
        dir: File = File(tmp.root, "update"),
        auto: Boolean = false,
    ) = UpdateController(
        Current, source, downloader, installer, store, dir, this, nowMs = { now }, minInterval = 3 * hours,
        io = StandardTestDispatcher(testScheduler), autoUpdate = { auto },
    )

    @Test fun autoUpdateDownloadsAndInstallsOnADueCheck() = runTest {
        val downloader = FakeDownloader(ApkBytes)
        val installer = FakeInstaller()
        val c = controller(downloader = downloader, installer = installer, auto = true)
        assertTrue(c.checkIfDue())
        assertEquals(1, downloader.calls)
        assertEquals(1, installer.installed.size)
        assertEquals(UpdatePhase.Installing, c.state.value.phase)
    }

    @Test fun autoUpdateOffOnlyChecks() = runTest {
        val downloader = FakeDownloader(ApkBytes)
        val installer = FakeInstaller()
        val c = controller(downloader = downloader, installer = installer, auto = false)
        assertTrue(c.checkIfDue())
        advanceUntilIdle()
        assertTrue(c.state.value.available)
        assertEquals(0, downloader.calls)
        assertTrue(installer.installed.isEmpty())
    }

    @Test fun autoUpdateNeverOpensTheInstallPermissionPage() = runTest {
        val downloader = FakeDownloader(ApkBytes)
        val c = controller(downloader = downloader, installer = FakeInstaller(allowed = false), auto = true)
        val requests = mutableListOf<Unit>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { c.permissionRequests.collect { requests += it } }
        assertTrue(c.checkIfDue())
        advanceUntilIdle()
        assertEquals(0, downloader.calls)
        assertTrue(requests.isEmpty())
        assertEquals(UpdatePhase.Idle, c.state.value.phase)
    }

    @Test fun autoUpdateSkipsWhenNothingNewer() = runTest {
        val downloader = FakeDownloader(ApkBytes)
        val c = controller(source = FakeUpdateSource(UpdateAnswer(Release120.copy(code = 4, name = "1.1.1"), MinVersion(1, "1.0.0"))), downloader = downloader, auto = true)
        assertTrue(c.checkIfDue())
        assertEquals(0, downloader.calls)
    }

    @Test fun autoUpdateRunsOnlyWithADueCheck() = runTest {
        val downloader = FakeDownloader(ApkBytes, ok = false)
        val c = controller(downloader = downloader, auto = true)
        assertTrue(c.checkIfDue())
        assertEquals(UpdatePhase.Failed(UpdatePhase.DOWNLOAD_FAILED), c.state.value.phase)
        now += hours
        assertFalse(c.checkIfDue())
        assertEquals(1, downloader.calls)
        now += 3 * hours
        assertTrue(c.checkIfDue())
        assertEquals(2, downloader.calls)
    }

    @Test fun newerBuildIsAvailableNotRequired() = runTest {
        val c = controller()
        assertTrue(c.check())
        val s = c.state.value
        assertTrue(s.available)
        assertFalse(s.required)
        assertEquals("1.2.0", s.targetName)
    }

    @Test fun sameOrOlderBuildIsNotOffered() = runTest {
        val c = controller(source = FakeUpdateSource(UpdateAnswer(Release120.copy(code = 4, name = "1.1.1"), MinVersion(1, "1.0.0"))))
        c.check()
        assertFalse(c.state.value.available)
        assertNull(c.state.value.targetName)
    }

    @Test fun belowTheMinimumIsRequired() = runTest {
        val c = controller(source = FakeUpdateSource(UpdateAnswer(Release120, MinVersion(6, "1.2.0"))))
        c.check()
        assertTrue(c.state.value.required)
        assertEquals("1.2.0", c.state.value.targetName)
    }

    @Test fun prefsMinAppAloneMakesItRequired() = runTest {
        val store = MemoryUpdateStore()
        val c = controller(source = FakeUpdateSource(null), store = store)
        advanceUntilIdle()
        c.onMinApp(MinVersion(5, "1.1.2"))
        assertTrue(c.state.value.required)
        assertEquals("1.1.2", c.state.value.targetName)
        advanceUntilIdle()
        assertEquals(MinVersion(5, "1.1.2"), store.saved?.answer?.min)
    }

    @Test fun checksAtMostEveryFewHours() = runTest {
        val source = FakeUpdateSource(UpdateAnswer(null, MinVersion(1, "1.0.0")))
        val c = controller(source = source)
        assertTrue(c.checkIfDue())
        now += 2 * hours
        assertFalse(c.checkIfDue())
        now += 2 * hours
        assertTrue(c.checkIfDue())
        assertEquals(2, source.calls)
    }

    @Test fun anOfflineCheckKeepsTheLastAnswerAndRetriesNextTime() = runTest {
        val source = FakeUpdateSource(UpdateAnswer(Release120, MinVersion(1, "1.0.0")))
        val c = controller(source = source)
        c.check()
        source.answer = null
        now += 4 * hours
        assertFalse(c.checkIfDue())
        assertTrue(c.state.value.available)
        assertFalse(c.checkIfDue()) // still due: the failed check did not count
        assertEquals(3, source.calls)
    }

    @Test fun savedAnswerIsRestoredAtLaunchWithoutAsking() = runTest {
        val source = FakeUpdateSource(null)
        val c = controller(source = source, store = MemoryUpdateStore(UpdateStore.Saved(UpdateAnswer(Release120, MinVersion(6, "1.2.0")), now - hours)))
        assertFalse(c.checkIfDue())
        assertTrue(c.state.value.available)
        assertTrue(c.state.value.required)
        assertEquals(0, source.calls)
    }

    @Test fun downloadsVerifiesAndInstalls() = runTest {
        val downloader = FakeDownloader(ApkBytes)
        val installer = FakeInstaller()
        val c = controller(downloader = downloader, installer = installer)
        c.check()
        val phases = mutableListOf<UpdatePhase>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { c.state.collect { phases += it.phase } }
        c.update()
        advanceUntilIdle()
        assertEquals(1, installer.installed.size)
        assertEquals(ApkBytes.size.toLong(), installer.installed[0].length())
        assertEquals(UpdatePhase.Installing, c.state.value.phase)
        assertEquals(listOf(150_000L, 300_000L), downloader.progress)
        assertTrue(phases.any { it is UpdatePhase.Downloading })
    }

    @Test fun hashMismatchDeletesTheFileAndSaysDownloadFailed() = runTest {
        val bad = ApkBytes.copyOf().also { it[10] = (it[10] + 1).toByte() }
        val installer = FakeInstaller()
        val dir = File(tmp.root, "update")
        val c = controller(downloader = FakeDownloader(bad), installer = installer, dir = dir)
        c.check()
        c.update()
        advanceUntilIdle()
        assertEquals(UpdatePhase.Failed("Download failed"), c.state.value.phase)
        assertTrue(installer.installed.isEmpty())
        assertTrue(dir.listFiles().orEmpty().isEmpty())
    }

    @Test fun failedDownloadSaysDownloadFailed() = runTest {
        val c = controller(downloader = FakeDownloader(ApkBytes.copyOf(1000), ok = false))
        c.check()
        c.update()
        advanceUntilIdle()
        assertEquals(UpdatePhase.Failed(UpdatePhase.DOWNLOAD_FAILED), c.state.value.phase)
    }

    @Test fun aVerifiedCopyIsNotDownloadedAgain() = runTest {
        val dir = File(tmp.root, "update").apply { mkdirs() }
        File(dir, "Linkpearl-6.apk").writeBytes(ApkBytes)
        val downloader = FakeDownloader(ApkBytes)
        val installer = FakeInstaller()
        val c = controller(downloader = downloader, installer = installer, dir = dir)
        c.check()
        c.update()
        advanceUntilIdle()
        assertEquals(0, downloader.calls)
        assertEquals(1, installer.installed.size)
    }

    @Test fun asksForInstallPermissionThenContinuesOnResume() = runTest {
        val installer = FakeInstaller(allowed = false)
        val c = controller(installer = installer)
        val requests = mutableListOf<Unit>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { c.permissionRequests.collect { requests += it } }
        c.check()
        c.update()
        advanceUntilIdle()
        assertEquals(UpdatePhase.NeedsPermission, c.state.value.phase)
        assertEquals(1, requests.size)
        assertTrue(installer.installed.isEmpty())

        installer.allowed = true
        c.onResume()
        advanceUntilIdle()
        assertEquals(1, installer.installed.size)
        assertEquals(UpdatePhase.Installing, c.state.value.phase)
    }

    @Test fun permissionRefusedGoesBackToIdle() = runTest {
        val c = controller(installer = FakeInstaller(allowed = false))
        c.check(); c.update(); advanceUntilIdle()
        c.onResume(); advanceUntilIdle()
        assertEquals(UpdatePhase.Idle, c.state.value.phase)
    }

    @Test fun installerOutcomes() = runTest {
        val c = controller()
        c.check(); c.update(); advanceUntilIdle()
        c.onInstallStatus(InstallStatus.Aborted)
        assertEquals(UpdatePhase.Idle, c.state.value.phase)
        c.onInstallStatus(InstallStatus.Failure)
        assertEquals(UpdatePhase.Failed(UpdatePhase.INSTALL_FAILED), c.state.value.phase)
    }

    @Test fun installSessionThatCannotStartFails() = runTest {
        val c = controller(installer = FakeInstaller(starts = false))
        c.check(); c.update(); advanceUntilIdle()
        assertEquals(UpdatePhase.Failed(UpdatePhase.INSTALL_FAILED), c.state.value.phase)
    }

    @Test fun updateWithNothingPublishedFails() = runTest {
        val c = controller(source = FakeUpdateSource(UpdateAnswer(null, MinVersion(6, "1.2.0"))))
        c.update(); advanceUntilIdle()
        assertEquals(UpdatePhase.Failed(UpdatePhase.DOWNLOAD_FAILED), c.state.value.phase)
    }

    @Test fun oldApksAreCleanedAtStart() = runTest {
        val dir = File(tmp.root, "update").apply { mkdirs() }
        File(dir, "Linkpearl-4.apk").writeText("old")
        File(dir, "Linkpearl-6.apk").writeText("newer")
        controller(dir = dir)
        advanceUntilIdle()
        assertEquals(listOf("Linkpearl-6.apk"), dir.list()!!.toList())
    }

    @Test fun checkNowAsksEvenWhenNotDueAndSaysUpToDate() = runTest {
        val source = FakeUpdateSource(UpdateAnswer(Release120.copy(code = 4, name = "1.1.1"), MinVersion(1, "1.0.0")))
        val c = controller(source = source)
        assertTrue(c.checkIfDue())
        c.checkNow()
        advanceUntilIdle()
        assertEquals(2, source.calls)
        assertEquals(CheckStatus.UpToDate, c.state.value.checkStatus)
    }

    @Test fun checkNowFindsAnUpdateAndInstallsWithAutoUpdate() = runTest {
        val installer = FakeInstaller()
        val c = controller(installer = installer, auto = true)
        c.checkNow()
        advanceUntilIdle()
        assertTrue(c.state.value.available)
        assertEquals(CheckStatus.Idle, c.state.value.checkStatus)
        assertEquals(1, installer.installed.size)
    }

    @Test fun checkNowSaysWhenTheServerCantBeReached() = runTest {
        val c = controller(source = FakeUpdateSource(null))
        c.checkNow()
        advanceUntilIdle()
        assertEquals(CheckStatus.Failed, c.state.value.checkStatus)
        assertFalse(c.state.value.available)
    }
}
