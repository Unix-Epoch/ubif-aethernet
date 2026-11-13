package dev.aethernet.linkpearl.core.nav

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.adaptive.HingeInfo
import androidx.compose.material3.adaptive.Posture
import androidx.compose.material3.adaptive.WindowAdaptiveInfo
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.adaptiveInfoFor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

/** The pane boundary comes from the fold information, with a rail's offset accounted for; nothing is placed across the fold. */
@RunWith(RobolectricTestRunner::class)
class HingeTwoPaneTest {
    @get:Rule val rule = createComposeRule()

    private fun setUp(device: Device, info: WindowAdaptiveInfo, railDp: Int = 0) {
        RuntimeEnvironment.setQualifiers("w${device.widthDp}dp-h${device.heightDp}dp-xhdpi")
        rule.setContent {
            CompositionLocalProvider(LocalDensity provides Density(2f)) {
                AdaptiveProvider(info) {
                    Box(Modifier.fillMaxSize().padding(start = railDp.dp)) {
                        HingeTwoPane(
                            modifier = Modifier.fillMaxSize(),
                            first = { Box(Modifier.fillMaxSize().testTag("a")) },
                            second = { Box(Modifier.fillMaxSize().testTag("b")) },
                        )
                    }
                }
            }
        }
        rule.waitForIdle()
    }

    @Test fun boundaryIsOnTheHingeBesideARail() {
        setUp(Device.Inner, adaptiveInfoFor(Device.Inner), railDp = 96) // fold at 429.5dp in the window
        val a = rule.onNodeWithTag("a").getUnclippedBoundsInRoot()
        val b = rule.onNodeWithTag("b").getUnclippedBoundsInRoot()
        assertEquals(96f, a.left.value, 1.5f)
        assertEquals(429.5f - 16f, a.right.value, 1.5f) // gutter (32dp minimum on a zero-width fold) centred on the fold
        assertEquals(429.5f + 16f, b.left.value, 1.5f)
        assertTrue("nothing across the fold", a.right.value <= 429.5f - 15f && b.left.value >= 429.5f + 15f)
    }

    @Test fun withoutAFoldTheGutterIsCentred() {
        setUp(Device.InnerNoFold, adaptiveInfoFor(Device.InnerNoFold))
        val a = rule.onNodeWithTag("a").getUnclippedBoundsInRoot()
        val b = rule.onNodeWithTag("b").getUnclippedBoundsInRoot()
        assertEquals(859f / 2 - 16f, a.right.value, 1.5f)
        assertEquals(859f / 2 + 16f, b.left.value, 1.5f)
    }

    @Test fun stateReadsTheFoldAndPosture() {
        val flat = AdaptiveState.from(adaptiveInfoFor(Device.Inner))
        assertFalse(flat.isCompact); assertNotNull(flat.hinge); assertFalse(flat.isTabletop)
        val phone = AdaptiveState.from(adaptiveInfoFor(Device.Phone))
        assertTrue(phone.isCompact); assertNull(phone.hinge)
        val cover = AdaptiveState.from(adaptiveInfoFor(Device.Cover))
        assertTrue(cover.isCompact)
        // half-opened with a horizontal fold = tabletop (exposed for later; Home does not use it)
        val size = adaptiveInfoFor(Device.Inner).windowSizeClass
        val tabletop = AdaptiveState.from(WindowAdaptiveInfo(size, Posture(true, listOf(HingeInfo(Rect(0f, 900f, 1718f, 900f), false, false, true, false)))))
        assertTrue(tabletop.isTabletop); assertNull(tabletop.hinge); assertNotNull(tabletop.tabletopFold)
    }

    @Test fun destinationsMapToTopLevel() {
        assertEquals(TopLevel.Alerts, TopLevel.of("alerts/settings"))
        assertEquals(TopLevel.WorkOrders, TopLevel.of("workorders/{id}"))
        assertEquals(TopLevel.Home, TopLevel.of("home"))
        assertNull(TopLevel.of("onboarding"))
        assertEquals("linkpearl://workorders/{id}", Routes.deepLink(Routes.WORK_ORDER))
    }
}
