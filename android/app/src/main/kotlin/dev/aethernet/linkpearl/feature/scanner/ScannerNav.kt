package dev.aethernet.linkpearl.feature.scanner

import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import androidx.navigation.navDeepLink
import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.FeatureModule
import dev.aethernet.linkpearl.core.di.LocalAppContainer
import dev.aethernet.linkpearl.core.nav.Routes
import dev.aethernet.linkpearl.feature.pullbacks.PullbackCamera
import dev.aethernet.linkpearl.feature.pullbacks.QR_FORMATS
import dev.aethernet.linkpearl.feature.pullbacks.SERIAL_FORMATS
import dev.aethernet.linkpearl.feature.scan.SCAN_FORMATS

/** Provides [ScannerPrefs]; installed by SettingsModule (Settings > Scanner owns it, every viewfinder reads it). */
object ScannerModule : FeatureModule {
    override fun install(c: AppContainer) {
        c.provide<ScannerPrefs> { DataStoreScannerPrefs(c.application) }
    }
}

/** `settings/scanner` (also `linkpearl://settings/scanner`), opened from Settings > Device. */
fun NavGraphBuilder.scannerGraph() {
    composable(Routes.SCANNER, deepLinks = listOf(navDeepLink { uriPattern = Routes.deepLink(Routes.SCANNER) })) { ScannerRoute() }
}

@Composable
fun ScannerRoute() {
    val c = LocalAppContainer.current
    val back = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
    val vm: ScannerViewModel = viewModel(factory = viewModelFactory { initializer { ScannerViewModel(c.get<ScannerPrefs>(), c.appScope) } })
    val ui by vm.state.collectAsStateWithLifecycle()
    DisposableEffect(vm) { onDispose { vm.flush() } }
    ScannerScreen(
        ui,
        ScannerActions(
            onBack = { back?.onBackPressed() }, onPick = vm::pick, onChange = vm::change, onArea = vm::setArea, onCode = vm::onCode, onReset = vm::reset,
        ),
        camera = { tuning, onCode, onArea ->
            // Labels reads every label format the app scans (serials and Scan's codes); QR reads pairing codes.
            val formats = if (ui.kind == ScanKind.Qr) QR_FORMATS else (SERIAL_FORMATS + SCAN_FORMATS).distinct()
            PullbackCamera("", onCode, formats, tuning = tuning, onArea = onArea)
        },
    )
}
