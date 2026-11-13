package dev.aethernet.linkpearl.feature.onboarding

import android.content.Context
import android.os.Build
import android.provider.Settings
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.aethernet.linkpearl.core.data.Auth
import dev.aethernet.linkpearl.core.data.AuthIssue
import dev.aethernet.linkpearl.core.data.AuthIssues
import dev.aethernet.linkpearl.core.data.AuthState
import dev.aethernet.linkpearl.core.di.AppContainer
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class OnboardingStep { FirstRun, Waiting, NoStores }

/** Everything the onboarding screen draws. [name] is the field's text on FirstRun and the registered device's name after that. */
data class OnboardingUi(
    val step: OnboardingStep = OnboardingStep.FirstRun,
    val name: String = "",
    val fingerprint: String = "",
    val busy: Boolean = false,
    val issue: AuthIssue? = null,
)

class OnboardingViewModel(
    private val auth: Auth,
    private val issues: AuthIssues,
    defaultName: String,
) : ViewModel() {
    private data class Local(val name: String, val busy: Boolean)

    private val local = MutableStateFlow(Local(defaultName, false))

    val state: StateFlow<OnboardingUi> = combine(auth.state, issues.issue, local) { a, issue, l ->
        when (a) {
            AuthState.Unregistered -> OnboardingUi(OnboardingStep.FirstRun, l.name, busy = l.busy, issue = issue)
            is AuthState.Pending -> OnboardingUi(OnboardingStep.Waiting, a.name, a.fingerprint, l.busy, issue)
            is AuthState.Registered -> OnboardingUi(OnboardingStep.NoStores, a.name, busy = l.busy, issue = issue)
        }
    }.stateIn(viewModelScope, SharingStarted.Eagerly, OnboardingUi(name = defaultName))

    fun setName(text: String) { local.update { it.copy(name = text.take(60)) }; if (issues.issue.value != null) issues.dismissIssue() }

    fun register() {
        if (local.value.busy || local.value.name.isBlank()) return
        viewModelScope.launch {
            local.update { it.copy(busy = true) }
            try { auth.register(local.value.name) } finally { local.update { it.copy(busy = false) } }
        }
    }

    fun checkNow() {
        if (local.value.busy) return
        viewModelScope.launch {
            local.update { it.copy(busy = true) }
            try { auth.refresh() } finally { local.update { it.copy(busy = false) } }
        }
    }

    fun cancel() { viewModelScope.launch { auth.signOut() } }

    /** Polls /me while the screen is visible (the caller cancels it when the screen is hidden). Backs off, then holds at 30 s. */
    suspend fun poll() {
        var n = 0
        while (true) {
            delay(pollDelayMs(n++))
            if (state.value.step != OnboardingStep.FirstRun && !local.value.busy) auth.refresh()
        }
    }

    companion object {
        /** 5 s three times, then 10 s, 15 s, 20 s, and 30 s from there on. */
        fun pollDelayMs(attempt: Int): Long = when {
            attempt < 3 -> 5_000L
            attempt == 3 -> 10_000L
            attempt == 4 -> 15_000L
            attempt == 5 -> 20_000L
            else -> 30_000L
        }

        fun factory(c: AppContainer): ViewModelProvider.Factory = viewModelFactory {
            initializer { OnboardingViewModel(c.get<Auth>(), c.get<AuthIssues>(), defaultDeviceName(c.application)) }
        }
    }
}

/** The name the owner gave the phone (Settings > About), else "<Maker> <Model>" without repeating the maker. */
fun defaultDeviceName(context: Context): String {
    val user = runCatching { Settings.Global.getString(context.contentResolver, "device_name") }.getOrNull()
    return deviceNameFrom(user, Build.MANUFACTURER, Build.MODEL)
}

fun deviceNameFrom(userName: String?, manufacturer: String?, model: String?): String {
    userName?.trim()?.takeIf { it.isNotEmpty() }?.let { return it.take(60) }
    val maker = manufacturer.orEmpty().trim().replaceFirstChar { it.uppercase() }
    val m = model.orEmpty().trim()
    val name = when {
        m.isEmpty() -> maker.ifEmpty { "Phone" }
        maker.isEmpty() || m.startsWith(maker, ignoreCase = true) -> m
        else -> "$maker $m"
    }
    return name.take(60)
}
