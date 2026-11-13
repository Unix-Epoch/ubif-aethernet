package dev.aethernet.linkpearl

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import dev.aethernet.linkpearl.core.design.LinkpearlTheme
import dev.aethernet.linkpearl.core.di.LocalAppContainer
import dev.aethernet.linkpearl.core.nav.AdaptiveProvider
import dev.aethernet.linkpearl.core.nav.LinkpearlRoot

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val container = (application as LinkpearlApp).container
        setContent {
            CompositionLocalProvider(LocalAppContainer provides container) {
                LinkpearlTheme { AdaptiveProvider { LinkpearlRoot() } }
            }
        }
    }
}
