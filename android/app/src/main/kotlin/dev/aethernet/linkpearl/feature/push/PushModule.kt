package dev.aethernet.linkpearl.feature.push

import android.app.Activity
import android.app.Application
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dev.aethernet.linkpearl.LinkpearlApp
import dev.aethernet.linkpearl.R
import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.data.SessionStore
import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.FeatureModule
import dev.aethernet.linkpearl.core.nav.Routes
import dev.aethernet.linkpearl.feature.linkshell.LinkshellClient
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Push (Firebase Cloud Messaging). Firebase is set up only when android/gradle.properties has the linkpearl.firebase.* values
 * (app/build.gradle.kts turns them into the resources Firebase reads at start-up); without them nothing here runs.
 */
object PushModule : FeatureModule {
    const val CHANNEL = "linkshell"
    const val ORDERING = "ordering"

    override fun install(c: AppContainer) {
        val app = c.application
        c.channel(AppContainer.ChannelSpec(CHANNEL, "Linkshell", NotificationManager.IMPORTANCE_HIGH))
        c.channel(AppContainer.ChannelSpec(ORDERING, "Ordering", NotificationManager.IMPORTANCE_DEFAULT))
        c.provide<PushCenter> {
            val session = c.get<SessionStore>()
            val prefs = app.getSharedPreferences("lp-push", Context.MODE_PRIVATE)
            PushCenter(
                api = c.get<ApiClient>(),
                credentials = { session.current.credentials },
                link = { c.get<LinkshellClient>().state.value.link },
                wakeLink = { c.get<LinkshellClient>().wake() },
                notifier = AndroidPushNotifier(app),
                sentToken = object : PushCenter.TokenMemo {
                    override fun get() = prefs.getString("sent", null)
                    override fun set(v: String) { prefs.edit().putString("sent", v).apply() }
                },
                scope = c.appScope,
            )
        }
        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityStarted(activity: Activity) { c.get<PushCenter>().started++ }
            override fun onActivityStopped(activity: Activity) { c.get<PushCenter>().let { it.started = (it.started - 1).coerceAtLeast(0) } }
            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
            override fun onActivityResumed(activity: Activity) {}
            override fun onActivityPaused(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
        if (!configured(app)) return
        // The token can change with the device's registration (a new device id), so it is sent again for each one.
        c.appScope.launch {
            c.get<SessionStore>().flow.map { it.credentials?.id }.distinctUntilChanged().collect { id ->
                if (id != null) runCatching { FirebaseMessaging.getInstance().token.addOnSuccessListener { c.get<PushCenter>().onToken(it) } }
            }
        }
    }

    fun configured(context: Context) = runCatching { FirebaseApp.getApps(context).isNotEmpty() }.getOrDefault(false)
}

class AndroidPushNotifier(private val context: Context) : PushNotifier {
    override fun show(note: PushNote) {
        val nm = NotificationManagerCompat.from(context)
        if (!nm.areNotificationsEnabled()) return
        val tap = Intent(Intent.ACTION_VIEW, Uri.parse(Routes.deepLink(note.route))).setPackage(context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val linkshell = note.channel == PushModule.CHANNEL
        val n = NotificationCompat.Builder(context, note.channel)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setContentTitle(note.title).setContentText(note.text)
            .setPriority(if (linkshell) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(if (linkshell) NotificationCompat.CATEGORY_MESSAGE else NotificationCompat.CATEGORY_STATUS)
            .setAutoCancel(true).apply { if (linkshell) setTimeoutAfter(TIMEOUT_MS) }
            .setContentIntent(PendingIntent.getActivity(context, NOTE_ID, tap, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .build()
        try { nm.notify(if (linkshell) TAG else ORDERING_TAG, NOTE_ID, n) } catch (_: SecurityException) {}
    }

    companion object {
        const val TAG = "linkshell"
        const val ORDERING_TAG = "ordering" // its own slot: never replaces a Linkshell request
        const val NOTE_ID = 1 // one at a time: a newer request replaces the last
        const val TIMEOUT_MS = 30 * 60_000L
    }
}

/** FCM's entry point: new tokens and data messages. */
class LinkpearlMessagingService : FirebaseMessagingService() {
    private val center get() = (application as LinkpearlApp).container.get<PushCenter>()
    override fun onNewToken(token: String) { center.onToken(token) }
    override fun onMessageReceived(message: RemoteMessage) { center.onPing(message.data) }
}
