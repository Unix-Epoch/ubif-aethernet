package dev.aethernet.linkpearl.core.lock

import android.app.Activity
import android.app.Application
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_STRONG
import android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import android.hardware.biometrics.BiometricPrompt
import android.os.Bundle
import android.os.CancellationSignal
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.lang.ref.WeakReference
import kotlin.coroutines.resume

/**
 * Follows the app's activities without touching MainActivity: the resumed one (for the system prompt and FLAG_SECURE) and whether
 * any is started (background / foreground for the lock's grace period).
 */
class ActivityTracker(private val onBackground: () -> Unit, private val onForeground: () -> Unit) : Application.ActivityLifecycleCallbacks {
    private var started = 0
    private var resumed: WeakReference<Activity>? = null

    val current: Activity? get() = resumed?.get()

    override fun onActivityStarted(activity: Activity) {
        if (started++ == 0) onForeground()
    }

    override fun onActivityStopped(activity: Activity) {
        started = (started - 1).coerceAtLeast(0)
        if (started == 0 && !activity.isChangingConfigurations) onBackground()
    }

    override fun onActivityResumed(activity: Activity) { resumed = WeakReference(activity) }
    override fun onActivityPaused(activity: Activity) {}
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    override fun onActivityDestroyed(activity: Activity) { if (resumed?.get() === activity) resumed = null }
}

/**
 * The platform BiometricPrompt (API 30+ allows BIOMETRIC_STRONG or DEVICE_CREDENTIAL, so the phone's PIN/pattern/password is the
 * fallback; there is no app passphrase). Uses the framework class, which needs no FragmentActivity. No CryptoObject: the device key
 * is time-bound (AUTH_VALIDITY_SECONDS), unwrapping runs right after success.
 */
class SystemUnlockPrompt(private val activity: () -> Activity?) : UnlockPrompt {
    override suspend fun authenticate(): PromptResult = withContext(Dispatchers.Main) {
        val a = activity() ?: return@withContext PromptResult.Error
        val authenticators = BIOMETRIC_STRONG or DEVICE_CREDENTIAL
        val bm = a.getSystemService(BiometricManager::class.java)
        when (bm?.canAuthenticate(authenticators)) {
            BiometricManager.BIOMETRIC_SUCCESS, null -> Unit
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> return@withContext PromptResult.NoCredential
            else -> Unit // let the prompt itself report the problem
        }
        suspendCancellableCoroutine { cont ->
            val cancel = CancellationSignal()
            cont.invokeOnCancellation { cancel.cancel() }
            val prompt = BiometricPrompt.Builder(a)
                .setTitle("Unlock customer details")
                .setAllowedAuthenticators(authenticators)
                .build()
            prompt.authenticate(cancel, a.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult?) {
                    if (cont.isActive) cont.resume(PromptResult.Success)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence?) {
                    if (cont.isActive) cont.resume(mapError(errorCode))
                }
                // onAuthenticationFailed (one wrong finger) keeps the prompt open: nothing to do.
            })
        }
    }

    private fun mapError(code: Int): PromptResult = when (code) {
        BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED, BiometricPrompt.BIOMETRIC_ERROR_CANCELED -> PromptResult.Cancelled
        BiometricPrompt.BIOMETRIC_ERROR_LOCKOUT -> PromptResult.Lockout
        BiometricPrompt.BIOMETRIC_ERROR_LOCKOUT_PERMANENT -> PromptResult.LockoutPermanent
        BiometricPrompt.BIOMETRIC_ERROR_NO_DEVICE_CREDENTIAL, BiometricPrompt.BIOMETRIC_ERROR_NO_BIOMETRICS -> PromptResult.NoCredential
        else -> PromptResult.Error
    }
}
