package dev.aethernet.linkpearl.feature.linkshell

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.aethernet.linkpearl.feature.pullbacks.PcRun
import dev.aethernet.linkpearl.feature.pullbacks.PullbackLink
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/** What the Linkshell screen shows. */
sealed interface LsUi {
    /** Not linked: the camera, looking for Aethernet's QR code. */
    data class Scan(val busy: Boolean = false, val error: String? = null) : LsUi
    /** Scanned: the browser and the check code, until Link is pressed there. */
    data class Check(val pcName: String, val store: Int, val code: String) : LsUi
    /** [peer]: the browser is connected. [offer]: a Pullbacks run it sent ("Scan with phone"). */
    data class Linked(val pcName: String, val store: Int, val peer: Boolean, val seen: String?, val offer: PcRun?, val error: String? = null) : LsUi
}

class LinkshellViewModel(
    private val client: LinkshellClient,
    private val repo: LinkshellRepository,
    private val pullbacks: PullbackLink?,
    private val now: () -> Long = System::currentTimeMillis,
    private val pollMs: Long = 2_000L,
    private val pairMs: Long = 5 * 60_000L,
) : ViewModel() {
    private val _state = MutableStateFlow<LsUi>(LsUi.Scan())
    val state: StateFlow<LsUi> = _state.asStateFlow()
    private var waiting: Job? = null
    private var linkedError: String? = null

    init {
        client.wake()
        viewModelScope.launch {
            combine(client.state, pullbacks?.offer ?: MutableStateFlow(null)) { s, offer -> s to offer }.collect { (s, offer) ->
                val l = s.link
                if (l != null) { waiting?.cancel(); _state.value = LsUi.Linked(l.pcName, l.store, s.peer, s.seen, offer, linkedError) }
                else if (_state.value is LsUi.Linked) _state.value = LsUi.Scan()
            }
        }
    }

    /** A code from the camera. Anything but an Aethernet pairing code is ignored. */
    fun onCode(text: String) {
        val cur = _state.value as? LsUi.Scan ?: return
        if (cur.busy) return
        val code = PairCode.parse(text) ?: return
        _state.value = LsUi.Scan(busy = true)
        viewModelScope.launch {
            when (val r = repo.pair(code)) {
                is PairResult.Ok -> waitForLink(r.pairing)
                PairResult.Failed.Expired -> _state.value = LsUi.Scan(error = "Code expired")
                PairResult.Failed.NoAccess -> _state.value = LsUi.Scan(error = "This phone isn't set up for that store")
                PairResult.Failed.Taken -> _state.value = LsUi.Scan(error = "Another phone scanned this code")
                PairResult.Failed.Offline -> _state.value = LsUi.Scan(error = "No connection")
                PairResult.Failed.Error -> _state.value = LsUi.Scan(error = "Couldn't link")
            }
        }
    }

    /** Shows the check code and waits for Link on the browser (its link shows up in this phone's list). */
    private fun waitForLink(p: Pairing) {
        _state.value = LsUi.Check(p.pcName, p.store, p.check)
        waiting?.cancel()
        waiting = viewModelScope.launch {
            val until = now() + pairMs
            while (now() < until) {
                delay(pollMs)
                if (repo.links()?.any { it.id == p.linkId } == true) { client.link(LinkshellRepository.stored(p, now())); return@launch }
            }
            _state.value = LsUi.Scan(error = "Code expired")
        }
    }

    fun cancel() { waiting?.cancel(); _state.value = LsUi.Scan() }

    fun unlink() {
        val l = client.state.value.link ?: return
        viewModelScope.launch {
            if (repo.unlink(l.linkId)) { linkedError = null; client.forget() }
            else { linkedError = "Couldn't unlink"; (_state.value as? LsUi.Linked)?.let { _state.value = it.copy(error = linkedError) } }
        }
    }

    /** Join the browser's Pullbacks run; the caller opens Pullbacks. */
    fun join(): Boolean {
        val offer = (_state.value as? LsUi.Linked)?.offer ?: return false
        pullbacks?.join(offer) ?: return false
        return true
    }
}
