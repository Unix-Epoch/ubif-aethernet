package dev.aethernet.linkpearl.core.lock

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.view.WindowManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalContext
import java.util.WeakHashMap

/**
 * Sets FLAG_SECURE on the hosting activity's window while [enabled] (unlocked customer details are on screen): no screenshots, no
 * screen recording, a blank thumbnail in Recents. Reference-counted per window so two panes showing details do not clear each other.
 * Compose-only; MainActivity is not touched.
 */
@Composable
fun SecureWindow(enabled: Boolean) {
    val activity = LocalContext.current.findActivity() ?: return
    DisposableEffect(activity, enabled) {
        if (enabled) SecureFlag.acquire(activity)
        onDispose { if (enabled) SecureFlag.release(activity) }
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
