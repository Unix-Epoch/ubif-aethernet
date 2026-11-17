package dev.aethernet.linkpearl.feature.pullbacks

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.ImageAnalysis
import androidx.camera.mlkit.vision.MlKitAnalyzer
import androidx.camera.view.CameraController
import androidx.camera.view.LifecycleCameraController
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.unit.toSize
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.design.StateMessage

/**
 * The camera viewfinder for Pullbacks: CameraX preview + ML Kit's bundled barcode model (1D codes and QR). Every frame's codes are read;
 * only codes whose centre is inside the scan frame count (the rest of the view is ignored); of those, the one that matches [expected]
 * wins, else the first. The same value is passed on at most once every 1.5 s, so holding the label in
 * view doesn't scan it again. Asks for the camera permission the first time; without it, a line and a retry.
 */
@Composable
fun PullbackCamera(expected: String, onCode: (String) -> Unit) {
    val context = LocalContext.current
    var granted by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }
    LaunchedEffect(Unit) { if (!granted) ask.launch(Manifest.permission.CAMERA) }
    if (!granted) {
        Box(Modifier.fillMaxSize().background(Lp.colors.surf3), contentAlignment = Alignment.Center) {
            StateMessage("Camera is off", actionLabel = "Allow camera", onAction = { ask.launch(Manifest.permission.CAMERA) })
        }
        return
    }
    val owner = LocalLifecycleOwner.current
    val want by rememberUpdatedState(Pullbacks.norm(expected))
    val emit by rememberUpdatedState(onCode)
    val controller = remember {
        LifecycleCameraController(context).apply {
            setEnabledUseCases(CameraController.IMAGE_ANALYSIS)
            imageAnalysisBackpressureStrategy = ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST
        }
    }
    val scanner = remember {
        BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder().setBarcodeFormats(
                Barcode.FORMAT_CODE_128, Barcode.FORMAT_CODE_39, Barcode.FORMAT_CODE_93, Barcode.FORMAT_CODABAR, Barcode.FORMAT_EAN_13,
                Barcode.FORMAT_EAN_8, Barcode.FORMAT_ITF, Barcode.FORMAT_UPC_A, Barcode.FORMAT_UPC_E, Barcode.FORMAT_QR_CODE, Barcode.FORMAT_DATA_MATRIX,
            ).build(),
        )
    }
    var last by remember { mutableStateOf("" to 0L) }
    // The scan frame in the preview's pixels (the analyzer's boxes are view-referenced, so they share these coordinates).
    var frame by remember { mutableStateOf<Rect?>(null) }
    val inFrame by rememberUpdatedState(frame)
    DisposableEffect(controller, owner) {
        val executor = ContextCompat.getMainExecutor(context)
        controller.setImageAnalysisAnalyzer(executor, MlKitAnalyzer(listOf(scanner), CameraController.COORDINATE_SYSTEM_VIEW_REFERENCED, executor) { result ->
            val f = inFrame ?: return@MlKitAnalyzer
            val codes = result.getValue(scanner).orEmpty()
                .filter { b -> b.boundingBox?.let { r -> f.contains(Offset(r.exactCenterX(), r.exactCenterY())) } == true }
                .mapNotNull { it.rawValue?.trim()?.takeIf(String::isNotEmpty) }
            if (codes.isEmpty()) return@MlKitAnalyzer
            val v = codes.firstOrNull { Pullbacks.norm(it) == want } ?: codes.first()
            val now = System.currentTimeMillis()
            if (v == last.first && now - last.second < 1500) return@MlKitAnalyzer
            last = v to now
            emit(v)
        })
        controller.bindToLifecycle(owner)
        onDispose { controller.unbind(); controller.clearImageAnalysisAnalyzer() }
    }
    DisposableEffect(scanner) { onDispose { scanner.close() } }
    Box(Modifier.fillMaxSize()) {
        AndroidView({ ctx -> PreviewView(ctx).apply { this.controller = controller; scaleType = PreviewView.ScaleType.FILL_CENTER } }, Modifier.fillMaxSize())
        Box(
            Modifier.align(Alignment.Center).fillMaxWidth().padding(horizontal = 28.dp).height(72.dp).border(2.dp, Lp.colors.fg, LpShapes.Card)
                .onGloballyPositioned { frame = Rect(it.positionInParent(), it.size.toSize()) },
        )
    }
}
