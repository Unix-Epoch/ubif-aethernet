package dev.aethernet.linkpearl.core.lock

import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class SecureWindowTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @After fun reset() { CapturePolicy.allowed.value = false }

    @Test fun developerSwitchLiftsTheFlagWhileDetailsAreShown() {
        val shown = mutableStateOf(true)
        rule.setContent { SecureWindow(enabled = shown.value) }
        rule.waitForIdle()
        assertTrue(SecureFlag.isSet(rule.activity))

        CapturePolicy.allowed.value = true
        rule.waitForIdle()
        assertFalse(SecureFlag.isSet(rule.activity))

        CapturePolicy.allowed.value = false
        rule.waitForIdle()
        assertTrue(SecureFlag.isSet(rule.activity))

        shown.value = false
        rule.waitForIdle()
        assertFalse(SecureFlag.isSet(rule.activity))
    }
}
