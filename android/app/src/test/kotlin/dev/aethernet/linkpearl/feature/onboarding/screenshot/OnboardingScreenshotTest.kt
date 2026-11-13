package dev.aethernet.linkpearl.feature.onboarding.screenshot

import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.feature.onboarding.OnboardingScreen
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.shoot
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Owner of feature/onboarding: this is your screenshot test. Add your states here; outputs land in android/screenshots/onboarding/. */
@RunWith(RobolectricTestRunner::class)
class OnboardingScreenshotTest {
    @get:Rule val rule = createComposeRule()

    @Test fun phoneDark() = rule.shoot("onboarding", "stub", Device.Phone, dark = true) { OnboardingScreen() }
}
