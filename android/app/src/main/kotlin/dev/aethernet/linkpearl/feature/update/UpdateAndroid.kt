package dev.aethernet.linkpearl.feature.update

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import androidx.core.content.IntentCompat
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.aethernet.linkpearl.LinkpearlApp
import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.data.Credentials
import dev.aethernet.linkpearl.core.data.LinkpearlJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

/** [UpdateSource] over the app's [ApiClient]. */
class ApiUpdateSource(private val api: ApiClient) : UpdateSource {
    override suspend fun check(): UpdateAnswer? = when (val r = api.get("/v1/agents/m/update")) {
        is ApiResult.Success -> UpdateAnswer.parse(r.value)
        is ApiResult.Failure -> null
    }
}

/**
 * `GET /v1/agents/m/update/apk?code=N` with the same headers as every request. Stops (false) on a non-200 answer, on a network
 * error, or when the server sends more than `size` bytes. HTTPS only; redirects are not followed.
 */
class OkHttpApkDownloader(
    private val baseUrl: String,
    private val appKey: String,
    private val credentials: () -> Credentials?,
    private val userAgent: String,
    private val appVersion: String,
    client: OkHttpClient = OkHttpClient(),
    /** Tests only: plain http to localhost. */
    private val allowLoopbackHttp: Boolean = false,
) : ApkDownloader {
    private val http = client.newBuilder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(0, TimeUnit.SECONDS).build()

    override suspend fun download(release: Release, into: File, onProgress: (Long) -> Unit): Boolean = withContext(Dispatchers.IO) {
        try {
            val base = baseUrl.toHttpUrl()
            if (!base.isHttps && !(allowLoopbackHttp && base.host in setOf("localhost", "127.0.0.1"))) return@withContext false
            val url = base.newBuilder().addPathSegments("v1/agents/m/update/apk").addQueryParameter("code", release.code.toString()).build()
            val creds = credentials() ?: return@withContext false
            val request = Request.Builder().url(url)
                .header("x-aethernet-key", appKey).header("authorization", creds.bearer)
                .header("user-agent", userAgent).header("x-linkpearl-version", appVersion).build()
            http.newCall(request).execute().use { r ->
                if (r.code != 200) return@withContext false
                var written = 0L
                r.body.byteStream().use { input ->
                    into.outputStream().use { out ->
                        val buf = ByteArray(64 * 1024)
                        var lastReport = 0L
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            written += n
                            if (written > release.size) return@withContext false
                            out.write(buf, 0, n)
                            if (written - lastReport >= 32 * 1024 || written == release.size) { lastReport = written; onProgress(written) }
                        }
                    }
                }
                onProgress(written)
                written == release.size
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            false
        }
    }
}

/**
 * Installs through a [PackageInstaller] session. The APK is signed with the same key as the installed app, so it replaces it and keeps
 * the registration. Android reports back to [UpdateInstallReceiver]; the first time (and whenever Android asks) that is
 * STATUS_PENDING_USER_ACTION and the receiver opens the system's confirm screen.
 */
class PackageInstallerApkInstaller(private val context: Context) : ApkInstaller {
    override fun canInstall(): Boolean = context.packageManager.canRequestPackageInstalls()

    override suspend fun install(apk: File): Boolean = withContext(Dispatchers.IO) {
        try {
            val installer = context.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                setAppPackageName(context.packageName)
                setSize(apk.length())
                // Once Linkpearl has installed itself, later updates may go through without the confirm screen (Android decides).
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
                if (Build.VERSION.SDK_INT >= 34) setPackageSource(PackageInstaller.PACKAGE_SOURCE_OTHER)
            }
            val id = installer.createSession(params)
            installer.openSession(id).use { session ->
                session.openWrite("base.apk", 0, apk.length()).use { out ->
                    apk.inputStream().use { it.copyTo(out) }
                    session.fsync(out)
                }
                val intent = Intent(context, UpdateInstallReceiver::class.java).setAction(UpdateInstallReceiver.ACTION).setPackage(context.packageName)
                // Mutable: the installer adds its status extras to this (explicit) intent.
                val pending = PendingIntent.getBroadcast(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
                session.commit(pending.intentSender)
            }
            true
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            false
        }
    }
}

/** The package installer's status broadcast for our sessions (not exported: only the PendingIntent above reaches it). */
class UpdateInstallReceiver : BroadcastReceiver() {
    @SuppressLint("UnsafeIntentLaunch") // the intent is the system installer's own confirm screen, sent to our private receiver
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            val confirm = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java) ?: return
            runCatching { context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            return
        }
        val app = context.applicationContext as? LinkpearlApp ?: return
        runCatching { app.container.get<UpdateController>() }.getOrNull()?.onInstallStatus(installStatus(status))
    }

    companion object {
        const val ACTION = "dev.aethernet.linkpearl.UPDATE_STATUS"

        fun installStatus(status: Int): InstallStatus = when (status) {
            PackageInstaller.STATUS_SUCCESS -> InstallStatus.Success
            PackageInstaller.STATUS_FAILURE_ABORTED -> InstallStatus.Aborted
            else -> InstallStatus.Failure
        }
    }
}

private val Context.updateDataStore: DataStore<Preferences> by preferencesDataStore(name = "update")
private val KEY_ANSWER = stringPreferencesKey("answer")
private val KEY_CHECKED = longPreferencesKey("checked_at")

class DataStoreUpdateStore(private val context: Context) : UpdateStore {
    override suspend fun load(): UpdateStore.Saved? {
        val p = context.updateDataStore.data.first()
        val answer = p[KEY_ANSWER]?.let { runCatching { LinkpearlJson.decodeFromString(UpdateAnswer.serializer(), it) }.getOrNull() } ?: return null
        return UpdateStore.Saved(answer, p[KEY_CHECKED] ?: 0L)
    }

    override suspend fun save(saved: UpdateStore.Saved) {
        context.updateDataStore.edit {
            it[KEY_ANSWER] = LinkpearlJson.encodeToString(UpdateAnswer.serializer(), saved.answer)
            it[KEY_CHECKED] = saved.checkedAtMs
        }
    }
}
