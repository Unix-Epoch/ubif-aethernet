package dev.aethernet.linkpearl.core.nav

import androidx.activity.OnBackPressedDispatcher
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Linkpearl 1.2.10 crash (StackOverflowError): Retrace's panel closed by dispatching Back, which its own BackHandler turned into another close. */
@RunWith(RobolectricTestRunner::class)
class SlideInPanelBackTest {
    @get:Rule val rule = createComposeRule()

    @Test fun anOnCloseThatDispatchesBackRunsOnce() {
        var back: OnBackPressedDispatcher? = null
        var closes = 0
        rule.setContent {
            back = LocalOnBackPressedDispatcherOwner.current!!.onBackPressedDispatcher
            SlideInPanelHost(
                open = true, initiallyOpen = true, onClose = { closes++; back!!.onBackPressed() },
                base = { Box(Modifier.fillMaxSize()) }, panel = { Box(Modifier.fillMaxSize()) },
            )
        }
        rule.runOnIdle { back!!.onBackPressed() }
        assertEquals(1, closes)
    }
}
