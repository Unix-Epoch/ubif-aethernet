package dev.aethernet.linkpearl.feature.push.screenshot

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.nav.LpNavScaffold
import dev.aethernet.linkpearl.core.nav.Routes
import dev.aethernet.linkpearl.core.nav.TopLevel
import dev.aethernet.linkpearl.feature.linkshell.LinkshellScreen
import dev.aethernet.linkpearl.feature.linkshell.LsUi
import dev.aethernet.linkpearl.feature.push.PushBanner
import dev.aethernet.linkpearl.feature.push.PushNote
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.shoot
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.ParameterizedRobolectricTestRunner.Parameters

/** The in-app banner for a Linkshell request, over a screen, dark and light. Output `push/phone-banner-<dark|light>.png`. */
@RunWith(ParameterizedRobolectricTestRunner::class)
class PushBannerScreenshotTest(private val dark: Boolean) {
    @get:Rule val rule = createComposeRule()

    companion object {
        @JvmStatic
        @Parameters(name = "dark={0}")
        fun params(): List<Array<Any>> = listOf(arrayOf(true), arrayOf(false))
    }

    @Test fun render() {
        rule.shoot("push", "banner", Device.Phone, dark) {
            Box(Modifier.fillMaxSize()) {
                LpNavScaffold(selected = TopLevel.Settings, onSelect = {}, showBar = false) {
                    LinkshellScreen(LsUi.Linked("Chrome · Mac", 999999, true, null, null), storeName = { "Sandbox" })
                }
                PushBanner(PushNote("m", "Pullbacks ready to scan", "Chrome · Mac", Routes.LINKSHELL), onClick = {}, modifier = Modifier.align(Alignment.TopCenter).padding(top = 36.dp))
            }
        }
    }
}
