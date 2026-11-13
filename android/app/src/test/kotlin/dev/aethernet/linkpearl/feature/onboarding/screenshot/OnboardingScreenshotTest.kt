package dev.aethernet.linkpearl.feature.onboarding.screenshot

import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.core.data.AuthIssue
import dev.aethernet.linkpearl.feature.onboarding.OnboardingContent
import dev.aethernet.linkpearl.feature.onboarding.OnboardingStep
import dev.aethernet.linkpearl.feature.onboarding.OnboardingUi
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.shoot
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.ParameterizedRobolectricTestRunner.Parameters

/** Onboarding states at phone, cover and inner sizes, dark and light. Output: android/screenshots/onboarding/. */
@RunWith(ParameterizedRobolectricTestRunner::class)
class OnboardingScreenshotTest(private val device: Device, private val dark: Boolean) {
    companion object {
        @JvmStatic @Parameters(name = "{0} dark={1}")
        fun params() = listOf(Device.Phone, Device.Cover, Device.Inner).flatMap { d -> listOf(true, false).map { arrayOf<Any>(d, it) } }

        val firstRun = OnboardingUi(OnboardingStep.FirstRun, "Pixel Fold")
        val waiting = OnboardingUi(OnboardingStep.Waiting, "Pixel Fold", "3F2A-91C0-7B44-0DDE")
        val noStores = OnboardingUi(OnboardingStep.NoStores, "Pixel Fold")
    }

    @get:Rule val rule = createComposeRule()

    private fun shoot(name: String, ui: OnboardingUi, fontScale: Float = 1f) =
        rule.shoot("onboarding", name, device, dark, fontScale) { OnboardingContent(ui, {}, {}, {}, {}) }

    @Test fun firstRun() = shoot("firstrun", firstRun)
    @Test fun revoked() = shoot("revoked", firstRun.copy(issue = AuthIssue.Revoked))
    @Test fun error() = shoot("error", firstRun.copy(issue = AuthIssue.Server))
    @Test fun offline() = shoot("offline", firstRun.copy(issue = AuthIssue.Offline))
    @Test fun waiting() = shoot("waiting", waiting)
    @Test fun waitingOffline() = shoot("waiting-offline", waiting.copy(issue = AuthIssue.Offline))
    @Test fun noStores() = shoot("nostores", noStores)
    @Test fun waitingBigFont() = if (device == Device.Phone) shoot("waiting-font1.3", waiting, 1.3f) else Unit
}
