package dev.aethernet.linkpearl.feature.linkshell

import dev.aethernet.linkpearl.core.data.Credentials
import dev.aethernet.linkpearl.core.data.EncryptedFile
import dev.aethernet.linkpearl.core.data.LinkpearlJson
import dev.aethernet.linkpearl.core.data.boolOrNull
import dev.aethernet.linkpearl.core.data.strOrNull
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap

/** The browser this phone is linked to. [key] = the AES-256 link key, base64; it only ever sits in an [EncryptedFile]. */
@Serializable
data class StoredLink(val linkId: String, val store: Int, val pcName: String, val key: String, val createdAt: Long = 0) {
    override fun toString() = "StoredLink(linkId=$linkId, store=$store, pcName=$pcName)"
}

/** A message waiting for the browser's ack. [body] = JSON text. */
@Serializable
data class OutMsg(val id: String, val kind: String, val body: String, val at: Long)

@Serializable
data class LinkshellData(val link: StoredLink? = null, val outbox: List<OutMsg> = emptyList(), val seen: List<String> = emptyList())

interface LinkshellStore {
    fun load(): LinkshellData
    fun save(d: LinkshellData)
}

/** `files/lp-linkshell.bin`, sealed with the app's Keystore key like the session. */
class FileLinkshellStore(private val file: EncryptedFile) : LinkshellStore {
    override fun load(): LinkshellData = runCatching { file.read()?.let { LinkpearlJson.decodeFromString(LinkshellData.serializer(), it.decodeToString()) } }.getOrNull() ?: LinkshellData()
    override fun save(d: LinkshellData) { if (d == LinkshellData()) file.delete() else file.write(LinkpearlJson.encodeToString(LinkshellData.serializer(), d).toByteArray()) }
}

class MemoryLinkshellStore(var data: LinkshellData = LinkshellData()) : LinkshellStore {
    override fun load() = data
    override fun save(d: LinkshellData) { data = d }
}

/** [online]: this phone is connected to the relay. [peer]: the browser is too. [seen]: when the browser was last connected (ISO), if known. */
data class LsState(val link: StoredLink? = null, val online: Boolean = false, val peer: Boolean = false, val seen: String? = null) {
    val linked get() = link != null
}

data class LsMessage(val id: String, val kind: String, val body: JsonObject)

// ---------------------------------------------------------------- the socket, swappable for tests
interface LsSocketListener {
    fun onOpen()
    fun onMessage(text: String)
    fun onClosed(code: Int)
}
interface LsSocket {
    fun send(text: String): Boolean
    fun close(code: Int, reason: String)
}
/**
 * Close code made up here (the relay never sends it): the relay refused this phone's credential when connecting (401 or 403: the phone
 * was deactivated, its token is no longer valid, or it lost the link's store).
 */
const val LS_CLOSE_REFUSED = 4401

fun interface LsSockets { fun open(url: String, protocols: List<String>, listener: LsSocketListener): LsSocket }

/** OkHttp's WebSocket. The credential goes in Sec-WebSocket-Protocol (the relay's rule, shared with browsers). */
class OkHttpSockets(private val client: OkHttpClient) : LsSockets {
    override fun open(url: String, protocols: List<String>, listener: LsSocketListener): LsSocket {
        val req = Request.Builder().url(url).header("Sec-WebSocket-Protocol", protocols.joinToString(", ")).build()
        val ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = listener.onOpen()
            override fun onMessage(webSocket: WebSocket, text: String) = listener.onMessage(text)
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null); listener.onClosed(code) }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = listener.onClosed(closeCodeFor(response?.code))
        })
        return object : LsSocket {
            override fun send(text: String) = ws.send(text)
            override fun close(code: Int, reason: String) { ws.close(code, reason) }
        }
    }

    companion object {
        /** The close code for a connect that failed with HTTP [status] (null = no answer): 404 = no such link, 401/403 = refused. */
        fun closeCodeFor(status: Int?): Int = when (status) {
            404 -> 4001
            401, 403 -> LS_CLOSE_REFUSED
            else -> 1006
        }
    }
}

/**
 * The phone's end of Linkshell (the browser's is src/67-linkshell.js; the relay is tracker-worker/src/linkshell.js).
 *
 * One link at a time. While linked, [wake] connects (screens that use the link call it, as does the app coming to the foreground), and
 * the socket closes after [idleMs] without messages. Every [send] goes to the outbox first and stays there until the browser acks it,
 * so a message sent while either end is away arrives later (the relay holds it up to 24 hours once it gets there). Received ids are
 * remembered, so a resend is handled once. Closes from the relay: 4001 = the link is gone (forgotten here), 4000 = this phone
 * connected again elsewhere. [LS_CLOSE_REFUSED] = the relay refused this phone: the link is kept, and nothing reconnects until the next
 * [wake] or [send] (retrying by itself would be refused for as long as the phone stays deactivated). Handlers ([on]) run one at a time, in order; a message is acked after its handler returns.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class LinkshellClient(
    private val store: LinkshellStore,
    private val sockets: LsSockets,
    /** `https://…` of the tracker Worker; the socket uses wss. */
    baseUrl: String,
    private val credentials: () -> Credentials?,
    scope: CoroutineScope,
    private val now: () -> Long = System::currentTimeMillis,
    private val idleMs: Long = 5 * 60_000L,
    private val pingMs: Long = 50_000L,
    /** Where everything here runs, one thing at a time (a test dispatcher in tests). */
    lane: CoroutineDispatcher = Dispatchers.Default.limitedParallelism(1),
) {
    private val scope = CoroutineScope(scope.coroutineContext + lane)
    private val wsBase = baseUrl.trimEnd('/').replaceFirst(Regex("^http"), "ws")
    private var data = store.load()
    private val _state = MutableStateFlow(LsState(data.link))
    val state: StateFlow<LsState> = _state.asStateFlow()
    private val handlers = ConcurrentHashMap<String, suspend (LsMessage) -> Unit>()

    private var socket: LsSocket? = null
    private var open = false
    private var gen = 0
    private var idleJob: Job? = null
    private var pingJob: Job? = null
    private var retryJob: Job? = null
    private var retryMs = 2_000L

    fun on(kind: String, handler: suspend (LsMessage) -> Unit) { handlers[kind] = handler }

    /** Queue [body] for the browser; returns the message id. */
    fun send(kind: String, body: JsonObject): String {
        val id = LinkshellCrypto.newId()
        scope.launch {
            if (data.link == null) return@launch
            update(data.copy(outbox = data.outbox + OutMsg(id, kind, body.toString(), now())))
            if (open) { push(data.outbox.last()); idle() } else connect()
        }
        return id
    }

    fun wake() { scope.launch { connect() } }

    /** A new link (pairing finished): replaces any other. */
    fun link(l: StoredLink) { scope.launch { drop(); update(LinkshellData(link = l)); connect() } }

    /** Forget the link here (after the server was told, or when it is already gone). */
    fun forget() { scope.launch { drop(); update(LinkshellData()) } }

    // ------------------------------------------------------------ internals (all on [lane])
    private fun update(d: LinkshellData) {
        data = d.copy(outbox = d.outbox.filter { now() - it.at < HOLD_MS })
        runCatching { store.save(data) }
        _state.value = _state.value.copy(link = data.link).let { if (data.link == null) LsState() else it }
    }

    private fun connect() {
        val l = data.link ?: return
        val c = credentials() ?: return
        if (socket != null) return
        retryJob?.cancel()
        val my = ++gen
        socket = sockets.open("$wsBase/v1/linkshell/connect?link=${l.linkId}", listOf("linkshell", "ph.${c.id}.${c.tokenValue}"), object : LsSocketListener {
            override fun onOpen() { scope.launch { if (my == gen) opened() } }
            override fun onMessage(text: String) { scope.launch { if (my == gen) receive(text) } }
            override fun onClosed(code: Int) { scope.launch { if (my == gen) closed(code) } }
        })
    }

    private fun opened() {
        open = true; retryMs = 2_000L
        _state.value = _state.value.copy(online = true)
        idle()
        pingJob?.cancel()
        pingJob = scope.launch { while (true) { delay(pingMs); socket?.send("ping") } }
        flush()
    }

    private fun closed(code: Int) {
        socket = null; open = false; gen++
        idleJob?.cancel(); pingJob?.cancel()
        _state.value = _state.value.copy(online = false, peer = false)
        when (code) {
            4001 -> update(LinkshellData())
            4000, 1000, LS_CLOSE_REFUSED -> {}
            else -> if (data.link != null) {
                val wait = retryMs
                retryMs = (retryMs * 2).coerceAtMost(60_000L)
                retryJob = scope.launch { delay(wait); connect() }
            }
        }
    }

    private fun drop() {
        val s = socket
        socket = null; open = false; gen++
        idleJob?.cancel(); pingJob?.cancel(); retryJob?.cancel()
        runCatching { s?.close(1000, "unlinked") }
        _state.value = _state.value.copy(online = false, peer = false)
    }

    private fun idle() {
        idleJob?.cancel()
        idleJob = scope.launch { delay(idleMs); socket?.close(1000, "idle"); closed(1000) }
    }

    private fun key(): ByteArray? = data.link?.let { Base64.getDecoder().decode(it.key) }

    private fun push(m: OutMsg) {
        val l = data.link ?: return
        val k = key() ?: return
        val (iv, ct) = LinkshellCrypto.seal(k, l.linkId, "phone", m.id, m.kind, m.body)
        socket?.send(buildJsonObject { put("t", "msg"); put("id", m.id); put("kind", m.kind); put("iv", iv); put("ct", ct) }.toString())
    }

    private fun flush() { if (open) data.outbox.forEach(::push) }

    private fun ack(id: String) { socket?.send(buildJsonObject { put("t", "ack"); putJsonArray("ids") { add(JsonPrimitive(id)) } }.toString()) }

    private suspend fun receive(text: String) {
        if (text == "pong") return
        idle()
        val f = runCatching { LinkpearlJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        fun str(k: String) = f.strOrNull(k)
        when (str("t")) {
            "hello", "presence" -> {
                _state.value = _state.value.copy(peer = f.boolOrNull("peer") == true, seen = str("seen") ?: _state.value.seen)
                if (str("t") == "hello") flush()
            }
            "ack" -> {
                val ids = (f["ids"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }?.toSet().orEmpty()
                if (ids.isNotEmpty()) update(data.copy(outbox = data.outbox.filterNot { it.id in ids }))
            }
            "msg" -> {
                val id = str("id") ?: return
                val kind = str("kind") ?: return
                val l = data.link ?: return
                if (id in data.seen) return ack(id)
                val body = runCatching {
                    LinkpearlJson.parseToJsonElement(LinkshellCrypto.open(key()!!, l.linkId, "pc", id, kind, str("iv")!!, str("ct")!!)).jsonObject
                }.getOrNull() ?: return ack(id) // not ours to read: dropped
                update(data.copy(seen = (data.seen + id).takeLast(SEEN_MAX)))
                handlers[kind]?.let { h -> runCatching { h(LsMessage(id, kind, body)) } }
                ack(id)
            }
        }
    }

    private companion object {
        const val HOLD_MS = 24 * 3600_000L
        const val SEEN_MAX = 400
    }
}
