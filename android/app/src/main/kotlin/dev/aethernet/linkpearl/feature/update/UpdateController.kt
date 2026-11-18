package dev.aethernet.linkpearl.feature.update

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.time.Duration.Companion.hours

/** `GET /v1/agents/m/update`; null when the server could not be asked (offline, refused, a bad answer). */
fun interface UpdateSource {
    suspend fun check(): UpdateAnswer?
}

/** Streams the APK of [release] into [into], reporting the bytes written so far. False on any failure (the caller deletes the file). */
fun interface ApkDownloader {
    suspend fun download(release: Release, into: File, onProgress: (Long) -> Unit): Boolean
}

/** Android's package installer. The outcome arrives later through [UpdateController.onInstallStatus]. */
interface ApkInstaller {
    /** Whether "Install unknown apps" is allowed for Linkpearl. */
    fun canInstall(): Boolean
    /** Starts an install session for [apk]; false when the session could not be written or committed. */
    suspend fun install(apk: File): Boolean
}

/** The last answer and when it was fetched, kept across launches so the app knows about an update (or a required one) before it asks again. */
interface UpdateStore {
    suspend fun load(): Saved?
    suspend fun save(saved: Saved)

    data class Saved(val answer: UpdateAnswer, val checkedAtMs: Long)
}

/**
 * The update logic (app-scoped: Settings, the nav dot and the "Update needed" gate share it). Checks `/m/update` at most every
 * [minInterval] (on launch and resume, and from the background check), downloads the APK to [dir] with progress, verifies its size
 * and SHA-256 (a mismatch deletes it), then hands it to the [installer], first sending the owner to "Install unknown apps" when needed
 * ([permissionRequests]; [onResume] carries on). The installer's result comes back through [onInstallStatus].
 */
class UpdateController(
    val current: AppVersion,
    private val source: UpdateSource,
    private val downloader: ApkDownloader,
    private val installer: ApkInstaller,
    private val store: UpdateStore,
    private val dir: File,
    private val scope: CoroutineScope,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val minInterval: Long = 3.hours.inWholeMilliseconds,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    /** The Auto-update switch: when on, a check that finds a new version downloads and installs it without a tap. */
    private val autoUpdate: suspend () -> Boolean = { false },
) {
    private val _state = MutableStateFlow(UpdateState(current))
    val state: StateFlow<UpdateState> = _state.asStateFlow()

    private val permission = Channel<Unit>(Channel.CONFLATED)
    /** Each element: open Android's "Install unknown apps" page for Linkpearl. */
    val permissionRequests: Flow<Unit> = permission.receiveAsFlow()

    private val checking = Mutex()
    private var lastCheckMs = 0L
    private var ready: File? = null
    private var job: Job? = null
    private val restored: Job = scope.launch {
        runCatching { store.load() }.getOrNull()?.let { s ->
            lastCheckMs = s.checkedAtMs
            apply(s.answer)
        }
        withContext(io) { cleanOld() }
    }

    /**
     * On launch, resume and the background check: asks the server unless it was asked less than [minInterval] ago. When it did ask
     * and Auto-update is on, a new version is downloaded and installed before this returns (so the background job waits for it).
     */
    suspend fun checkIfDue(): Boolean {
        restored.join()
        if (nowMs() - lastCheckMs < minInterval) return false
        val checked = check()
        if (checked) autoInstall()
        return checked
    }

    /**
     * Auto-update: at most once per check, never while one is running, and only when Android already lets Linkpearl install
     * (it never opens the "Install unknown apps" page on its own; the Update button does that).
     */
    private suspend fun autoInstall() {
        val s = _state.value
        if (!s.available || s.busy || s.phase == UpdatePhase.NeedsPermission || job?.isActive == true) return
        if (!runCatching { autoUpdate() }.getOrDefault(false) || !runCatching { installer.canInstall() }.getOrDefault(false)) return
        val j = scope.launch { run() }
        job = j
        j.join()
    }

    /** Asks the server now. False when it could not be reached (the last answer stays). */
    suspend fun check(): Boolean = checking.withLock {
        val answer = source.check() ?: return false
        lastCheckMs = nowMs()
        apply(answer)
        runCatching { store.save(UpdateStore.Saved(answer, lastCheckMs)) }
        true
    }

    /**
     * The Check for updates button: asks the server now, however recently it was asked. A new version then shows the Update row, and with
     * Auto-update on it is downloaded and installed like on a due check.
     */
    fun checkNow() {
        if (_state.value.checkStatus == CheckStatus.Checking) return
        _state.update { it.copy(checkStatus = CheckStatus.Checking) }
        scope.launch {
            restored.join()
            val ok = runCatching { check() }.getOrDefault(false)
            _state.update { it.copy(checkStatus = if (!ok) CheckStatus.Failed else if (it.available) CheckStatus.Idle else CheckStatus.UpToDate) }
            if (ok) autoInstall()
        }
    }

    /** The server's minimum from `/m/prefs` (`minApp`), which Settings reads anyway. */
    fun onMinApp(min: MinVersion) {
        if (_state.value.min == min) return
        _state.update { it.copy(min = min) }
        scope.launch {
            restored.join()
            val saved = runCatching { store.load() }.getOrNull()
            runCatching { store.save(UpdateStore.Saved((saved?.answer ?: UpdateAnswer()).copy(min = min), saved?.checkedAtMs ?: 0L)) }
        }
    }

    /** The Update button: download (unless a verified copy is already there), verify, install. Ignored while one is running. */
    fun update() {
        if (job?.isActive == true || _state.value.phase == UpdatePhase.Installing) return
        job = scope.launch { run() }
    }

    /** The app came back to the front: continue after the permission page, and check if due. */
    fun onResume() {
        if (_state.value.phase == UpdatePhase.NeedsPermission) {
            val apk = ready
            if (apk != null && installer.canInstall()) scope.launch { install(apk) } else setPhase(UpdatePhase.Idle)
        }
        scope.launch { runCatching { checkIfDue() } }
    }

    fun onInstallStatus(status: InstallStatus) {
        when (status) {
            // Android replaces the app and ends this process; until then nothing changes on screen.
            InstallStatus.Success -> setPhase(UpdatePhase.Installing)
            InstallStatus.Aborted -> setPhase(UpdatePhase.Idle)
            InstallStatus.Failure -> setPhase(UpdatePhase.Failed(UpdatePhase.INSTALL_FAILED))
        }
    }

    private suspend fun run() {
        var release = _state.value.latest?.takeIf { it.code > current.code }
        if (release == null) { runCatching { check() }; release = _state.value.latest?.takeIf { it.code > current.code } }
        if (release == null) return setPhase(UpdatePhase.Failed(UpdatePhase.DOWNLOAD_FAILED))

        val apk = File(dir, "Linkpearl-${release.code}.apk")
        val have = withContext(io) { runCatching { ApkVerify.matches(apk, release) }.getOrDefault(false) }
        if (!have) {
            withContext(io) { dir.mkdirs(); apk.delete() }
            setPhase(UpdatePhase.Downloading(0, release.size))
            val ok = runCatching {
                downloader.download(release, apk) { bytes -> setPhase(UpdatePhase.Downloading(bytes, release.size)) }
            }.getOrDefault(false)
            if (!ok) { withContext(io) { apk.delete() }; return setPhase(UpdatePhase.Failed(UpdatePhase.DOWNLOAD_FAILED)) }
            setPhase(UpdatePhase.Verifying)
            val good = withContext(io) { runCatching { ApkVerify.matches(apk, release) }.getOrDefault(false) }
            if (!good) { withContext(io) { apk.delete() }; return setPhase(UpdatePhase.Failed(UpdatePhase.DOWNLOAD_FAILED)) }
        }
        ready = apk
        install(apk)
    }

    private suspend fun install(apk: File) {
        if (!installer.canInstall()) {
            setPhase(UpdatePhase.NeedsPermission)
            permission.trySend(Unit)
            return
        }
        setPhase(UpdatePhase.Installing)
        val started = runCatching { installer.install(apk) }.getOrDefault(false)
        if (!started) setPhase(UpdatePhase.Failed(UpdatePhase.INSTALL_FAILED))
    }

    private fun apply(answer: UpdateAnswer) = _state.update { it.copy(latest = answer.latest, min = answer.min ?: it.min) }

    private fun setPhase(p: UpdatePhase) = _state.update { it.copy(phase = p) }

    /** APKs of this build or older are left over from an earlier update: delete them. */
    private fun cleanOld() {
        dir.listFiles()?.forEach { f ->
            val code = f.name.removePrefix("Linkpearl-").removeSuffix(".apk").toIntOrNull()
            if (code == null || code <= current.code) f.delete()
        }
    }
}
