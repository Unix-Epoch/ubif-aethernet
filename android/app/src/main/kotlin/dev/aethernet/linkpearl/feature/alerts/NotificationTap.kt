package dev.aethernet.linkpearl.feature.alerts

import android.content.Context
import android.content.Intent
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * Opening a notification counts as reading it: the tap's intent carries the alert ids, and the activity marks them read once
 * (the extras are removed, so a recreated activity does not send them again).
 *
 * The activity is exported (deep links, Portal links, shares), so any app can send it an intent with ids in it. The tap therefore also
 * carries this install's token, which only ever sits in the app's own storage and inside its own PendingIntents; ids without the right
 * token are ignored. The link itself still opens either way.
 */
object NotificationTap {
    const val EXTRA_ALERT_IDS = "dev.aethernet.linkpearl.alerts.TAP_IDS"
    const val EXTRA_TOKEN = "dev.aethernet.linkpearl.alerts.TAP_TOKEN"

    fun tag(intent: Intent, ids: List<Int>, token: String): Intent =
        if (ids.isEmpty()) intent else intent.putExtra(EXTRA_ALERT_IDS, ids.toIntArray()).putExtra(EXTRA_TOKEN, token)

    /** [token] is only asked for when the intent carries ids. */
    fun consume(intent: Intent?, token: () -> String, markRead: (List<Int>) -> Unit) {
        val ids = intent?.getIntArrayExtra(EXTRA_ALERT_IDS)?.toList().orEmpty()
        val given = intent?.getStringExtra(EXTRA_TOKEN)
        intent?.removeExtra(EXTRA_ALERT_IDS)
        intent?.removeExtra(EXTRA_TOKEN)
        if (ids.isEmpty() || given == null) return
        if (MessageDigest.isEqual(given.toByteArray(), token().toByteArray())) markRead(ids)
    }

    /** This install's token: 32 random bytes, made on first use and kept in the app's private preferences (never backed up or sent). */
    fun token(context: Context): String = synchronized(this) {
        val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString(KEY, null)?.takeIf { it.isNotEmpty() } ?: run {
            val t = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) })
            prefs.edit().putString(KEY, t).apply()
            t
        }
    }

    private const val PREFS = "alerts-tap"
    private const val KEY = "token"
}
