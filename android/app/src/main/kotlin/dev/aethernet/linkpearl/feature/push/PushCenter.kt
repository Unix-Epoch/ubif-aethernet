package dev.aethernet.linkpearl.feature.push

import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.data.Credentials
import dev.aethernet.linkpearl.core.nav.Routes
import dev.aethernet.linkpearl.feature.linkshell.StoredLink
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** A Linkshell wake from the tracker Worker (tracker-worker/src/push.js): ids and a kind word only, never job data. */
data class PushPing(val link: String, val kind: String, val id: String) {
    companion object {
        private val HEX32 = Regex("^[0-9a-f]{32}$")
        private val KIND = Regex("^[a-z][a-z0-9-]{0,30}(\\.[a-z0-9-]{1,30}){0,3}$")
        private val MID = Regex("^[A-Za-z0-9_-]{8,40}$")
        fun parse(data: Map<String, String>): PushPing? {
            if (data["t"] != "linkshell") return null
            val link = data["link"]?.takeIf { HEX32.matches(it) } ?: return null
            val kind = data["kind"]?.takeIf { KIND.matches(it) } ?: return null
            val id = data["id"]?.takeIf { MID.matches(it) } ?: return null
            return PushPing(link, kind, id)
        }
    }
}

/** What the phone shows for a ping: the same words in the notification and the in-app banner. [route] opens on tap. */
data class PushNote(val id: String, val title: String, val text: String, val route: String)

fun noteFor(ping: PushPing, pcName: String): PushNote = when (ping.kind) {
    "pullbacks.run" -> PushNote(ping.id, "Pullbacks ready to scan", pcName, Routes.LINKSHELL)
    else -> PushNote(ping.id, "Linkshell request", pcName, Routes.LINKSHELL)
}

/** Where a note goes when the app is in the background. */
fun interface PushNotifier { fun show(note: PushNote) }

/**
 * Push on the phone: keeps the server's copy of this phone's FCM token current, and turns a Linkshell ping into a system
 * notification (app in the background or closed) or a short banner at the top (app open). The ping wakes the Linkshell connection,
 * which brings the message itself.
 */
class PushCenter(
    private val api: ApiClient,
    private val credentials: () -> Credentials?,
    private val link: () -> StoredLink?,
    private val wakeLink: () -> Unit,
    private val notifier: PushNotifier,
    private val sentToken: TokenMemo,
    private val scope: CoroutineScope,
) {
    @Volatile var started = 0
    val foreground get() = started > 0

    private val _banners = MutableSharedFlow<PushNote>(extraBufferCapacity = 4)
    val banners: SharedFlow<PushNote> = _banners.asSharedFlow()
    private val seen = ArrayDeque<String>()

    /** A token from FCM (new, refreshed, or read at start-up). Sent once per device and token. */
    fun onToken(token: String) { scope.launch { register(token) } }

    suspend fun register(token: String): Boolean {
        val c = credentials() ?: return false
        val key = "${c.id}|$token"
        if (sentToken.get() == key) return true
        val r = api.post(PATH, buildJsonObject { put("token", token); put("platform", "android") })
        if (r is ApiResult.Success) sentToken.set(key)
        return r is ApiResult.Success
    }

    /** A data message from FCM. Returns what was shown, if anything. */
    @Synchronized
    fun onPing(data: Map<String, String>): PushNote? {
        val ping = PushPing.parse(data) ?: return null
        val l = link()?.takeIf { it.linkId == ping.link } ?: return null
        if (ping.id in seen) return null
        seen.addLast(ping.id); while (seen.size > 50) seen.removeFirst()
        val note = noteFor(ping, l.pcName)
        if (foreground) { _banners.tryEmit(note); wakeLink() } else notifier.show(note)
        return note
    }

    interface TokenMemo { fun get(): String?; fun set(v: String) }

    companion object { const val PATH = "/v1/agents/m/push" }
}
