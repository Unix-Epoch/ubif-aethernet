package dev.aethernet.linkpearl.core.lock

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.view.WindowManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.flow.MutableStateFlow
import java.util.WeakHashMap

/** The developer's "Allow screen capture" switch (Settings > Developer), mirrored here from AppPrefs by PrefsModule. */
object CapturePolicy {
    val allowed = MutableStateFlow(false)
}

/**
 * Sets FLAG_SECURE on the hosting activity's window while [enabled] (unlocked customer details are on screen): no screenshots, no
 * screen recording, a blank thumbnail in Recents. Reference-counted per window so two panes showing details do not clear each other.
 * Compose-only; MainActivity is not touched. Skipped while [CapturePolicy.allowed] is on.
 */
@Composable
fun SecureWindow(enabled: Boolean) {
    val activity = LocalContext.current.findActivity() ?: return
    val allowed by CapturePolicy.allowed.collectAsState()
    val secure = enabled && !allowed
    DisposableEffect(activity, secure) {
        if (secure) SecureFlag.acquire(activity)
        onDispose { if (secure) SecureFlag.release(activity) }
    }
}

internal object SecureFlag {
    private val counts = WeakHashMap<Activity, Int>()

    fun acquire(a: Activity) {
        val n = counts[a] ?: 0
        counts[a] = n + 1
        if (n == 0) a.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }

    fun release(a: Activity) {
        val n = (counts[a] ?: 1) - 1
        if (n <= 0) { counts.remove(a); a.window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) } else counts[a] = n
    }

    fun isSet(a: Activity): Boolean = (a.window?.attributes?.flags ?: 0) and WindowManager.LayoutParams.FLAG_SECURE != 0
}

tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
