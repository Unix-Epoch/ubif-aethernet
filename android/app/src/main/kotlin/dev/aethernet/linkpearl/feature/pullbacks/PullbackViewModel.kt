package dev.aethernet.linkpearl.feature.pullbacks

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** What the Pullbacks screen shows. */
sealed interface PbUi {
    /** Nothing open: the file picker, and the run saved on this phone when there is one. */
    data class Start(val saved: PbSaved? = null, val error: String? = null) : PbUi
    /** A file is open: pick the store. [stores] = (store text, items), the phone's own stores first. */
    data class Stores(val file: String, val stores: List<Pair<String, Int>>, val selected: String?, val value: Double?) : PbUi
    data class Scanning(val s: PbSession) : PbUi
    data class Done(val s: PbSession) : PbUi
}

/** The run saved on this phone, for the Start screen's Resume. */
data class PbSaved(val file: String, val store: String, val done: Int, val total: Int)

/**
 * The run on disk: the results file itself (`pullbacks/session.xlsx`, so a resume reads exactly what would be shared) plus where scanning
 * was (`pullbacks/session.json`: file name, store, current item, undo history). Serials and part names only, no customer data.
 */
interface PbStore {
    fun load(): PbSession?
    fun save(s: PbSession)
    fun clear()
}

class FilePbStore(private val dir: File) : PbStore {
    private val xlsx get() = File(dir, "session.xlsx")
    private val meta get() = File(dir, "session.json")
    override fun load(): PbSession? = runCatching {
        if (!xlsx.exists() || !meta.exists()) return null
        val m = JSONObject(meta.readText())
        val list = Pullbacks.parse(Pullbacks.readXlsx(xlsx.readBytes()))
        val h = m.optJSONArray("history") ?: JSONArray()
        val s = PbSession(m.getString("file"), m.getString("store"), list)
        val idx = if (m.has("idx") && !m.isNull("idx")) m.getInt("idx").takeIf { it in list.items.indices && list.items[it].status == PbStatus.Pending } else null
        s.copy(idx = idx ?: s.idx, history = (0 until h.length()).map { h.getInt(it) }.filter { it in list.items.indices })
    }.getOrNull()
    override fun save(s: PbSession) {
        dir.mkdirs()
        File(dir, "session.xlsx.tmp").apply { writeBytes(Pullbacks.results(s.list)); renameTo(xlsx) }
        File(dir, "session.json.tmp").apply {
            writeText(JSONObject().put("file", s.file).put("store", s.store).put("idx", s.idx ?: JSONObject.NULL).put("history", JSONArray(s.history.takeLast(200))).toString())
            renameTo(meta)
        }
    }
    override fun clear() { xlsx.delete(); meta.delete() }
}

class MemoryPbStore(var saved: PbSession? = null) : PbStore {
    override fun load() = saved
    override fun save(s: PbSession) { saved = s }
    override fun clear() { saved = null }
}

/** [myStores] = the store numbers this phone is approved for (their rows come first and the first is picked). */
class PullbackViewModel(
    private val store: PbStore,
    private val myStores: List<Int>,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {
    private val saver = io.limitedParallelism(1) // saves land in order
    private val _state = MutableStateFlow<PbUi>(PbUi.Start())
    val state: StateFlow<PbUi> = _state.asStateFlow()
    private var opened: Pair<String, PbList>? = null

    init { viewModelScope.launch { _state.value = PbUi.Start(withContext(io) { store.load() }?.let(::savedOf)) } }

    private fun savedOf(s: PbSession) = PbSaved(s.file, s.store, s.total - s.pending, s.total)

    /** A picked file's name and bytes. */
    fun open(name: String, bytes: ByteArray) = viewModelScope.launch {
        val parsed = withContext(io) {
            runCatching {
                val rows = if (name.endsWith(".csv", true)) Pullbacks.readCsv(String(bytes, Charsets.UTF_8).removePrefix("﻿")) else Pullbacks.readXlsx(bytes)
                Pullbacks.parse(rows)
            }
        }
        val list = parsed.getOrElse { e ->
            _state.value = PbUi.Start((_state.value as? PbUi.Start)?.saved, (e as? PullbackError)?.message ?: "Couldn't read this file.")
            return@launch
        }
        if (list.results) { begin(PbSession(name, Pullbacks.stores(list.items).firstOrNull()?.first.orEmpty(), list)); return@launch }
        val stores = Pullbacks.stores(list.items)
        if (stores.isEmpty()) { begin(PbSession(name, "", list)); return@launch }
        val mine = myStores.map { it.toString() }
        val ordered = stores.sortedBy { (s, _) -> mine.indexOf(Pullbacks.storeNum(s)).let { if (it < 0) Int.MAX_VALUE else it } }
        opened = name to list
        val selected = ordered.firstOrNull { Pullbacks.storeNum(it.first) in mine }?.first ?: ordered.first().first
        _state.value = PbUi.Stores(name, ordered, selected, valueOf(list, selected))
    }

    private fun valueOf(list: PbList, store: String): Double? =
        Pullbacks.forStore(list.items, store).mapNotNull { (it.returnValue as? Number)?.toDouble() }.takeIf { it.isNotEmpty() }?.sum()

    fun pickStore(s: String) { val st = _state.value as? PbUi.Stores ?: return; val l = opened?.second ?: return; _state.value = st.copy(selected = s, value = valueOf(l, s)) }

    fun start() {
        val st = _state.value as? PbUi.Stores ?: return
        val (name, list) = opened ?: return
        val store = st.selected ?: return
        begin(PbSession(name, store, list.copy(items = Pullbacks.forStore(list.items, store))))
    }

    private fun begin(s: PbSession) { opened = null; set(s) }

    private fun set(s: PbSession) {
        _state.value = if (s.complete) PbUi.Done(s) else PbUi.Scanning(s)
        viewModelScope.launch(saver) { store.save(s) }
    }
    private fun session(): PbSession? = when (val u = _state.value) { is PbUi.Scanning -> u.s; is PbUi.Done -> u.s; else -> null }

    fun scan(v: String) { val s = (_state.value as? PbUi.Scanning)?.s ?: return; set(s.scan(v)) }
    fun acceptAnyway() { val s = (_state.value as? PbUi.Scanning)?.s ?: return; set(s.acceptAnyway()) }
    fun skip() { val s = (_state.value as? PbUi.Scanning)?.s ?: return; set(s.skip()) }
    fun undo() { val s = session() ?: return; if (s.history.isNotEmpty()) set(s.undo()) }
    fun scanSkipped() { val s = session() ?: return; set(s.scanSkipped()) }
    fun resume() = viewModelScope.launch { withContext(io) { store.load() }?.let { _state.value = if (it.complete) PbUi.Done(it) else PbUi.Scanning(it) } }
    fun discard() { viewModelScope.launch(saver) { store.clear() }; _state.value = PbUi.Start() }
    fun changeFile() = viewModelScope.launch { opened = null; _state.value = PbUi.Start(withContext(io) { store.load() }?.let(::savedOf)) }
    fun newFile() = discard()

    /** The results file for sharing: name and bytes. */
    fun results(): Pair<String, ByteArray>? = session()?.let { Pullbacks.fileName(it.file, it.store) to Pullbacks.results(it.list) }
}
