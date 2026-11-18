package dev.aethernet.linkpearl.feature.pullbacks

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.VibrationEffect
import android.os.VibratorManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.ImageAnalysis
import androidx.camera.mlkit.vision.MlKitAnalyzer
import androidx.camera.view.CameraController
import androidx.camera.view.LifecycleCameraController
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.design.StateMessage
import dev.aethernet.linkpearl.core.di.LocalAppContainer
import dev.aethernet.linkpearl.feature.scanner.ScanArea
import dev.aethernet.linkpearl.feature.scanner.ScanGate
import dev.aethernet.linkpearl.feature.scanner.ScanKind
import dev.aethernet.linkpearl.feature.scanner.ScanTuning
import dev.aethernet.linkpearl.feature.scanner.ScannerPrefs
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flowOf
import kotlin.math.roundToInt

/** Serial labels are 1D codes (Code 128, sometimes Code 39 or 93). Product codes (UPC/EAN), QR and Data Matrix are left out unless a caller asks. */
val SERIAL_FORMATS = listOf(Barcode.FORMAT_CODE_128, Barcode.FORMAT_CODE_39, Barcode.FORMAT_CODE_93)
/** QR only: Aethernet's Linkshell pairing code. */
val QR_FORMATS = listOf(Barcode.FORMAT_QR_CODE)

/**
 * The camera viewfinder every scanner uses (Scan, Pullbacks, Linkshell): CameraX preview + ML Kit's bundled barcode model, reading
 * [formats] only. How it feels comes from Settings > Scanner ([ScannerPrefs], Labels or QR by [formats]) unless [tuning] is given:
 * the scanning area (only codes whose centre is inside it count), zoom, light, how many frames in a row must agree ([ScanGate]) and
 * how soon the same code may count again, and a vibration or beep per scan. Of the codes in the area, the one that matches
 * [expected] wins, else the first. With [onArea] (calibration) the area has corner handles and can be dragged.
 * Asks for the camera permission the first time; without it, a line and a retry.
 */
@Composable
fun PullbackCamera(
    expected: String,
    onCode: (String) -> Unit,
    formats: List<Int> = SERIAL_FORMATS,
    tuning: ScanTuning? = null,
    onArea: ((ScanArea) -> Unit)? = null,
) {
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
    val kind = ScanKind.of(formats)
    val container = LocalAppContainer.current
    val saved by remember(kind) {
        runCatching { container.get<ScannerPrefs>().tuning(kind) }.getOrElse { flowOf(ScanTuning.default(kind)) }
    }.collectAsState(initial = null)
    val t = tuning ?: saved ?: ScanTuning.default(kind)
    val tune by rememberUpdatedState(t)

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
            BarcodeScannerOptions.Builder().setBarcodeFormats(formats.first(), *formats.drop(1).toIntArray()).build(),
        )
    }
    val feedback = remember { ScanFeedback(context) }
    val gate = remember { ScanGate({ tune }) }
    // The viewfinder's size in pixels (the analyzer's boxes are view-referenced, so they share these coordinates).
    var box by remember { mutableStateOf(IntSize.Zero) }
    val boxNow by rememberUpdatedState(box)
    var hitAt by remember { mutableLongStateOf(0L) }
    DisposableEffect(controller, owner) {
        val executor = ContextCompat.getMainExecutor(context)
        controller.setImageAnalysisAnalyzer(executor, MlKitAnalyzer(listOf(scanner), CameraController.COORDINATE_SYSTEM_VIEW_REFERENCED, executor) { result ->
            val size = boxNow
            if (size.width == 0 || size.height == 0) return@MlKitAnalyzer
            val area = tune.area
            val codes = result.getValue(scanner).orEmpty()
                .filter { b -> b.boundingBox?.let { r -> area.contains(r.exactCenterX() / size.width, r.exactCenterY() / size.height) } == true }
                .mapNotNull { it.rawValue?.trim()?.takeIf(String::isNotEmpty) }
            val ordered = codes.firstOrNull { Pullbacks.norm(it) == want }?.let { listOf(it) + (codes - it) } ?: codes
            val v = gate.onFrame(ordered) ?: return@MlKitAnalyzer
            hitAt = System.currentTimeMillis()
            feedback.play(tune.vibrate, tune.sound)
            emit(v)
        })
        controller.bindToLifecycle(owner)
        onDispose { controller.unbind(); controller.clearImageAnalysisAnalyzer() }
    }
    DisposableEffect(scanner) { onDispose { scanner.close(); feedback.release() } }
    // Zoom and light once the camera is open (until then CameraX ignores them).
    LaunchedEffect(controller, t.zoom, t.light) {
        repeat(30) { if (controller.cameraInfo == null) delay(100) }
        val max = controller.zoomState.value?.maxZoomRatio ?: t.zoom
        runCatching { controller.setZoomRatio(t.zoom.coerceAtMost(max)) }
        runCatching { controller.enableTorch(t.light) }
    }
    var lit by remember { mutableStateOf(false) }
    LaunchedEffect(hitAt) { if (hitAt > 0) { lit = true; delay(700); lit = false } }

    Box(Modifier.fillMaxSize().onSizeChanged { box = it }) {
        AndroidView({ ctx -> PreviewView(ctx).apply { this.controller = controller; scaleType = PreviewView.ScaleType.FILL_CENTER } }, Modifier.fillMaxSize())
        ScanFrame(t.area, box, if (lit) Lp.colors.good else Lp.colors.fg, onArea)
    }
}

/** The scanning area's outline; with [onArea], two corner handles resize it and dragging inside moves it. */
@Composable
private fun ScanFrame(area: ScanArea, box: IntSize, color: Color, onArea: ((ScanArea) -> Unit)?) {
    if (box.width == 0 || box.height == 0) return
    val density = LocalDensity.current
    val w = box.width.toFloat(); val h = box.height.toFloat()
    val current by rememberUpdatedState(area)
    val change by rememberUpdatedState(onArea)
    fun px(x: Float, y: Float) = IntOffset((x * w).roundToInt(), (y * h).roundToInt())
    val frameMod = Modifier
        .offset { px(area.left, area.top) }
        .size(with(density) { ((area.right - area.left) * w).toDp() }, with(density) { ((area.bottom - area.top) * h).toDp() })
        .border(2.dp, color, LpShapes.Card)
    Box(Modifier.fillMaxSize()) {
        Box(
            if (onArea == null) frameMod else frameMod.semantics { contentDescription = "Scan area" }.pointerInput(Unit) {
                detectDragGestures { _, d ->
                    val a = current
                    val dx = d.x / w; val dy = d.y / h
                    val mx = dx.coerceIn(-a.left, 1f - a.right); val my = dy.coerceIn(-a.top, 1f - a.bottom)
                    change?.invoke(ScanArea(a.left + mx, a.top + my, a.right + mx, a.bottom + my))
                }
            },
        )
        if (onArea != null) {
            val handle = 28.dp
            val half = with(density) { (handle / 2).roundToPx() }
            Handle(Modifier.offset { px(area.left, area.top) - IntOffset(half, half) }.size(handle), color, "Top left corner") { dx, dy ->
                val a = current
                change?.invoke(a.copy(left = (a.left + dx / w).coerceIn(0f, a.right - ScanArea.MIN), top = (a.top + dy / h).coerceIn(0f, a.bottom - ScanArea.MIN)))
            }
            Handle(Modifier.offset { px(area.right, area.bottom) - IntOffset(half, half) }.size(handle), color, "Bottom right corner") { dx, dy ->
                val a = current
                change?.invoke(a.copy(right = (a.right + dx / w).coerceIn(a.left + ScanArea.MIN, 1f), bottom = (a.bottom + dy / h).coerceIn(a.top + ScanArea.MIN, 1f)))
            }
        }
    }
}

@Composable
private fun Handle(modifier: Modifier, color: Color, description: String, onDrag: (Float, Float) -> Unit) {
    val drag by rememberUpdatedState(onDrag)
    Box(
        modifier.semantics { contentDescription = description }.pointerInput(Unit) { detectDragGestures { _, d -> drag(d.x, d.y) } },
        contentAlignment = Alignment.Center,
    ) { Box(Modifier.size(14.dp).background(color, CircleShape)) }
}

/** A short vibration and/or beep per scan (Settings > Scanner). */
private class ScanFeedback(private val context: Context) {
    private var tone: ToneGenerator? = null

    fun play(vibrate: Boolean, sound: Boolean) {
        if (vibrate) runCatching {
            context.getSystemService(VibratorManager::class.java)?.defaultVibrator?.vibrate(VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK))
        }
        if (sound) runCatching {
            val g = tone ?: ToneGenerator(AudioManager.STREAM_NOTIFICATION, 80).also { tone = it }
            g.startTone(ToneGenerator.TONE_PROP_BEEP, 120)
        }
    }

    fun release() { tone?.release(); tone = null }
}
