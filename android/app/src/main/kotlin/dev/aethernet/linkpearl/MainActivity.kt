package dev.aethernet.linkpearl

import android.graphics.Color as AColor
import android.graphics.drawable.ColorDrawable
import android.content.res.Configuration
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.toArgb
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.aethernet.linkpearl.core.design.DarkLpColors
import dev.aethernet.linkpearl.core.design.LightLpColors
import dev.aethernet.linkpearl.core.design.LinkpearlTheme
import dev.aethernet.linkpearl.core.di.LocalAppContainer
import dev.aethernet.linkpearl.core.nav.AdaptiveProvider
import dev.aethernet.linkpearl.core.nav.LinkpearlRoot
import dev.aethernet.linkpearl.core.prefs.AppPrefs
import dev.aethernet.linkpearl.feature.workorders.PortalLink

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        // A Portal work order link (opened or shared) becomes a linkpearl://workorders/<number> link before the NavController reads the intent.
        setIntent(PortalLink.normalize(intent))
        val container = (application as LinkpearlApp).container
        val prefs = container.get<AppPrefs>()
        val first = prefs.appearanceNow() // read before the first frame: no flash of the wrong theme
        val systemDark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        applyTheme(first.isDark(systemDark))
        setContent {
            val appearance by prefs.appearance.collectAsStateWithLifecycle(first)
            val dark = appearance.isDark(isSystemInDarkTheme())
            // System bars and the window behind the first frame follow the chosen theme, not only the phone's.
            LaunchedEffect(dark) { applyTheme(dark) }
            CompositionLocalProvider(LocalAppContainer provides container) {
                LinkpearlTheme(darkTheme = dark) { AdaptiveProvider { LinkpearlRoot() } }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        val normalized = PortalLink.normalize(intent)
        super.onNewIntent(normalized)
        setIntent(normalized)
    }

    private fun applyTheme(dark: Boolean) {
        val bars = if (dark) SystemBarStyle.dark(AColor.TRANSPARENT) else SystemBarStyle.light(AColor.TRANSPARENT, AColor.TRANSPARENT)
        enableEdgeToEdge(statusBarStyle = bars, navigationBarStyle = bars)
        // The theme's XML window background already follows the phone's light/dark setting; this covers the in-app appearance choice
        // when it differs from the phone's.
        window.setBackgroundDrawable(ColorDrawable((if (dark) DarkLpColors else LightLpColors).page.toArgb()))
    }
}
