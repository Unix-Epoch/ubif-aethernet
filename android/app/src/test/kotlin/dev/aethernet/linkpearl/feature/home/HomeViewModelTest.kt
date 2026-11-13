package dev.aethernet.linkpearl.feature.home

import dev.aethernet.linkpearl.core.data.FailureReason
import dev.aethernet.linkpearl.core.data.FakeHomeData
import dev.aethernet.linkpearl.core.data.HomeData
import dev.aethernet.linkpearl.core.data.HomeRepository
import dev.aethernet.linkpearl.core.data.HomeResult
import dev.aethernet.linkpearl.core.data.StoreScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class HomeViewModelTest {
    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    private class Scripted(var next: HomeResult) : HomeRepository {
        val calls = mutableListOf<Pair<StoreScope, Boolean>>()
        override suspend fun load(scope: StoreScope, fresh: Boolean): HomeResult { calls += scope to fresh; return next }
    }

    private fun ok(data: HomeData = FakeHomeData.oneStore(), cached: Boolean = false) = HomeResult.Ok(data, cached)

    @Test fun loadsTheRememberedStoreFirst() = runTest {
        val repo = Scripted(ok())
        val vm = HomeViewModel(repo, MemoryStorePreference(StoreScope.One(326)))
        assertEquals(StoreScope.One(326), vm.state.value.scope)
        assertEquals(HomeView.Ok, vm.state.value.view)
        assertEquals(StoreScope.One(326) to false, repo.calls.single())
        assertEquals(2, vm.state.value.stores.size)
    }

    @Test fun pickingAStoreRemembersItAndReloads() = runTest {
        val prefs = MemoryStorePreference()
        val repo = Scripted(ok())
        val vm = HomeViewModel(repo, prefs)
        vm.pick(StoreScope.One(999999))
        assertEquals(StoreScope.One(999999), vm.state.value.scope)
        assertEquals(StoreScope.One(999999), prefs.scope.first())
    }

    @Test fun refreshAsksForFreshData() = runTest {
        val repo = Scripted(ok())
        val vm = HomeViewModel(repo, MemoryStorePreference())
        vm.refresh()
        assertTrue(repo.calls.last().second)
        assertFalse(vm.state.value.busy)
    }

    @Test fun firstLoadFailureIsAnErrorWithRetry() = runTest {
        val repo = Scripted(HomeResult.Failed(FailureReason.Server))
        val vm = HomeViewModel(repo, MemoryStorePreference())
        assertEquals(HomeView.Error, vm.state.value.view)
        assertNull(vm.state.value.data)
        repo.next = ok()
        vm.refresh()
        assertEquals(HomeView.Ok, vm.state.value.view)
    }

    @Test fun refreshFailureKeepsOldNumbersAndSaysSo() = runTest {
        val repo = Scripted(ok())
        val vm = HomeViewModel(repo, MemoryStorePreference())
        repo.next = HomeResult.Failed(FailureReason.Server)
        vm.refresh()
        assertEquals(HomeView.Ok, vm.state.value.view)
        assertNotNull(vm.state.value.data)
        assertTrue(vm.state.value.failed)
        assertFalse(vm.state.value.offline)
    }

    @Test fun offlineKeepsOldNumbersAndMarksOffline() = runTest {
        val repo = Scripted(ok())
        val vm = HomeViewModel(repo, MemoryStorePreference())
        repo.next = HomeResult.Failed(FailureReason.Offline)
        vm.refresh()
        assertTrue(vm.state.value.offline)
        assertFalse(vm.state.value.failed)
    }

    @Test fun cachedAnswerIsOffline() = runTest {
        val vm = HomeViewModel(Scripted(ok(cached = true)), MemoryStorePreference())
        assertTrue(vm.state.value.offline)
    }

    @Test fun switchingStoreDoesNotShowTheOtherStoresNumbers() = runTest {
        val repo = Scripted(ok(FakeHomeData.oneStore()))
        val vm = HomeViewModel(repo, MemoryStorePreference(StoreScope.One(999999)))
        repo.next = HomeResult.Failed(FailureReason.Server)
        vm.pick(StoreScope.All)
        assertEquals(HomeView.Error, vm.state.value.view)
        assertNull(vm.state.value.data)
    }
}
