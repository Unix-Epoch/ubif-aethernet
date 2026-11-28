package dev.aethernet.linkpearl.feature.morningcheck

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.aethernet.linkpearl.feature.linkshell.LinkshellCrypto
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface McUi {
    /** No PC linked: Linkshell first. */
    data object NoLink : McUi
    /** [pc]: the linked browser's name; [online]: it is connected now. */
    data class Start(val pc: String, val online: Boolean, val order: McOrder) : McUi
    /** Asked the PC; waiting for it to allow and send its list. */
    data class Waiting(val pc: String, val online: Boolean) : McUi
    data class Checking(val s: McSession, val pc: String, val online: Boolean) : McUi
    /** The PC declined or stopped the check. */
    data class Ended(val pc: String, val reason: String) : McUi
}

/**
 * Morning check on the phone. The check lives in [MorningCheckLink.saved] so leaving the screen and coming back picks it up again.
 */
class MorningCheckViewModel(private val link: MorningCheckLink, private val newId: () -> String = { LinkshellCrypto.newId() }) : ViewModel() {
    private val _state = MutableStateFlow<McUi>(McUi.NoLink)
    val state: StateFlow<McUi> = _state.asStateFlow()
    private var order = McOrder.Location
    private var waitingRun: String? = null
    private val asked = mutableSetOf<String>()

    private val pc get() = link.state.value.link?.pcName.orEmpty()
    private val online get() = link.state.value.peer

    init {
        link.wake()
        viewModelScope.launch {
            link.state.collect { s ->
                val ui = _state.value
                _state.value = if (s.link == null) McUi.NoLink else when (ui) {
                    is McUi.NoLink -> link.saved?.let { McUi.Checking(it, pc, s.peer) } ?: McUi.Start(pc, s.peer, order)
                    is McUi.Start -> ui.copy(pc = pc, online = s.peer)
                    is McUi.Waiting -> ui.copy(pc = pc, online = s.peer)
                    is McUi.Checking -> ui.copy(pc = pc, online = s.peer)
                    is McUi.Ended -> ui
                }
            }
        }
        viewModelScope.launch {
            link.list.collect { l ->
                if (l != null && l.run == waitingRun) { waitingRun = null; show(McSession.of(l, order)) }
            }
        }
        viewModelScope.launch {
            link.results.collect { r ->
                link.saved?.takeIf { it.run == r.run }?.let { s -> asked -= r.wo; show(s.result(r).dropNotes(r.wo)) } // a saved change can add notes
            }
        }
        viewModelScope.launch { link.notes.collect { (run, n) -> link.saved?.takeIf { it.run == run }?.let { show(it.withNotes(n)) } } }
        viewModelScope.launch {
            link.ended.collect { (run, reason) ->
                if (run == waitingRun || run == link.saved?.run) { waitingRun = null; link.saved = null; _state.value = McUi.Ended(pc, reason) }
            }
        }
    }

    private fun show(s: McSession) {
        val before = link.saved
        link.saved = s
        _state.value = McUi.Checking(s, pc, online)
        s.current?.row?.wo?.let { wo -> if (wo !in s.notes && asked.add(wo)) link.askNotes(s.run, wo) }
        if (before == null || before.done != s.done || before.total != s.total) link.progress(s.run, s.done, s.total)
    }
    private fun edit(f: (McSession) -> McSession) { link.saved?.let { show(f(it)) } }

    fun pickOrder(o: McOrder) { order = o; (_state.value as? McUi.Start)?.let { _state.value = it.copy(order = o) } }
    fun start() {
        val run = newId()
        waitingRun = run
        link.start(run)
        _state.value = McUi.Waiting(pc, online)
    }
    fun again() { asked.clear(); link.saved = null; _state.value = McUi.Start(pc, online, order) }
    fun looksRight() = edit { it.looksRight() }
    fun skip() = edit { it.skip() }
    fun next() = edit { it.advance() }
    fun scan(code: String) = edit { it.scan(code) }
    fun checkSkipped() = edit { it.checkSkipped() }
    fun save(c: McChange) {
        val s = link.saved ?: return
        val item = s.current ?: return
        if (c.empty) return
        val cid = newId()
        show(s.sending(cid, c))
        link.set(s.run, cid, item.row, c)
    }
    /** Send again only what Portal refused (a note that went through isn't added twice). */
    fun retry() {
        val item = link.saved?.current ?: return
        val c = item.last ?: return
        val f = item.failed.map { it.first }.toSet()
        if ("wo" in f || f.isEmpty()) return save(c)
        save(McChange(status = c.status.takeIf { "status" in f }, bin = c.bin.takeIf { "bin" in f }, nickname = c.nickname.takeIf { "nickname" in f }, note = c.note.takeIf { "note" in f }))
    }
    fun finish() { asked.clear(); link.saved?.let { link.end(it.run) }; link.saved = null; _state.value = McUi.Start(pc, online, order) }
}
