package dev.aethernet.linkpearl.feature.onboarding

import dev.aethernet.linkpearl.core.data.AuthIssue
import dev.aethernet.linkpearl.core.data.AuthState
import dev.aethernet.linkpearl.core.data.FakeAuth
import dev.aethernet.linkpearl.core.data.StoreRef
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class OnboardingViewModelTest {
    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    private fun vm(auth: FakeAuth) = OnboardingViewModel(auth, auth, "Pixel Fold")

    @Test fun eachAuthStateIsOneStep() = runTest {
        val auth = FakeAuth(AuthState.Unregistered)
        val vm = vm(auth)
        assertEquals(OnboardingUi(OnboardingStep.FirstRun, "Pixel Fold"), vm.state.value)
        auth.state.value = AuthState.Pending("3F2A-91C0-7B44-0DDE", "Pixel Fold")
        assertEquals(OnboardingUi(OnboardingStep.Waiting, "Pixel Fold", "3F2A-91C0-7B44-0DDE"), vm.state.value)
        auth.state.value = AuthState.Registered("Pixel Fold", emptyList())
        assertEquals(OnboardingStep.NoStores, vm.state.value.step)
        auth.state.value = AuthState.Registered("Pixel Fold", listOf(StoreRef(914, "Newport News")))
        assertEquals(OnboardingStep.NoStores, vm.state.value.step) // the screen is left by core/nav, not here
    }

    @Test fun registeringUsesTheEditedNameAndMovesToWaiting() = runTest {
        val auth = FakeAuth(AuthState.Unregistered)
        val vm = vm(auth)
        vm.setName("Garrett's Fold")
        vm.register()
        assertEquals(OnboardingStep.Waiting, vm.state.value.step); assertEquals("Garrett's Fold", vm.state.value.name)
        assertFalse(vm.state.value.busy)
    }

    @Test fun aBlankNameDoesNothingAndTheFieldIsCapped() = runTest {
        val auth = FakeAuth(AuthState.Unregistered)
        val vm = vm(auth)
        vm.setName("   "); vm.register()
        assertEquals(OnboardingStep.FirstRun, vm.state.value.step)
        vm.setName("x".repeat(90)); assertEquals(60, vm.state.value.name.length)
    }

    @Test fun anIssueShowsAndTypingClearsIt() = runTest {
        val auth = FakeAuth(AuthState.Unregistered)
        val vm = vm(auth)
        auth.issue.value = AuthIssue.Revoked
        assertEquals(AuthIssue.Revoked, vm.state.value.issue)
        vm.setName("Pixel")
        assertEquals(null, vm.state.value.issue)
    }

    @Test fun cancelAndSignOutGoBackToFirstRun() = runTest {
        val auth = FakeAuth(AuthState.Pending("A", "n"))
        val vm = vm(auth)
        vm.cancel()
        assertEquals(OnboardingStep.FirstRun, vm.state.value.step)
    }

    @Test fun pollingBacksOffThenHoldsAtThirtySeconds() {
        val delays = (0..9).map(OnboardingViewModel::pollDelayMs)
        assertEquals(listOf(5000L, 5000, 5000, 10000, 15000, 20000, 30000, 30000, 30000, 30000), delays)
        assertTrue(delays.all { it in 5_000..30_000 })
    }

    @Test fun deviceNamesFromThePhone() {
        assertEquals("Garrett's Z Fold", deviceNameFrom("  Garrett's Z Fold ", "samsung", "SM-F946U1"))
        assertEquals("Samsung SM-F946U1", deviceNameFrom(null, "samsung", "SM-F946U1"))
        assertEquals("Google Pixel Fold", deviceNameFrom(null, "Google", "Pixel Fold"))
        assertEquals("Pixel Fold", deviceNameFrom(null, "Pixel", "Pixel Fold"))
        assertEquals("Phone", deviceNameFrom(null, "", ""))
        assertEquals(60, deviceNameFrom("y".repeat(90), "a", "b").length)
    }

    @Test fun everyIssueHasPlainShortText() {
        AuthIssue.entries.forEach { assertTrue(issueText(it).length in 1..30) }
    }
}
