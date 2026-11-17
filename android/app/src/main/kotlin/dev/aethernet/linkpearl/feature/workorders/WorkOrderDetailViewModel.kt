package dev.aethernet.linkpearl.feature.workorders

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.aethernet.linkpearl.core.data.ApiError
import dev.aethernet.linkpearl.core.data.ApiResult
import dev.aethernet.linkpearl.core.data.Auth
import dev.aethernet.linkpearl.core.data.AuthState
import dev.aethernet.linkpearl.core.data.StoreRef
import dev.aethernet.linkpearl.core.lock.AppLock
import dev.aethernet.linkpearl.core.lock.SealedBox
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.LocalDate

/** The customer part of the detail. */
sealed interface SealedUi {
    data object Locked : SealedUi
    data object Loading : SealedUi
    /** Unlocked, but this phone holds no key for the work order's store. */
    data object NoKey : SealedUi
    /** Unlocked, but the tracker has neither a card nor a snapshot for it yet. */
    data object Missing : SealedUi
    data object Failed : SealedUi
    class Shown(val data: Unsealed) : SealedUi { override fun toString() = "Shown(redacted)" }
}

data class WoDetailUi(
    val key: WoKey? = null,
    val view: LoadView = LoadView.Loading,
    val detail: WoDetailResponse? = null,
    val problem: Problem? = null,
    val refreshing: Boolean = false,
    val receivedAtMs: Long? = null,
    val skewMs: Long = 0,
    val unlocked: Boolean = false,
    val sealed: SealedUi = SealedUi.Locked,
    val stores: List<StoreRef> = emptyList(),
    /** The Tags sheet, when open. */
    val tagsSheet: TagsSheetUi? = null,
    /** The Follow-up sheet, when open. */
    val followSheet: FollowSheetUi? = null,
    /** A short line for the snackbar (a failed change); cleared by [WorkOrderDetailViewModel.messageShown]. */
    val message: String? = null,
) {
    fun storeName(id: Int): String = stores.firstOrNull { it.id == id }?.label ?: "#$id"
    /** Tags and the follow-up can be changed on an open work order only. */
    val editable: Boolean get() = detail?.wo?.open == true
}

/** The Tags sheet: the store's managed list (null while loading or after a failure) and Waymark's limits. [busy]: tags being saved (lower case). */
data class TagsSheetUi(
    val loading: Boolean = true,
    val failed: Boolean = false,
    val managed: List<ManagedTag>? = null,
    val oneOff: Boolean = true,
    val maxTags: Int = WaymarkTags.MAX_TAGS,
    val maxLength: Int = WaymarkTags.MAX_LENGTH,
    val busy: Set<String> = emptySet(),
)

/** The Follow-up sheet: the picked new day, Remove armed (tap again to remove), a save under way. */
data class FollowSheetUi(val choice: LocalDate? = null, val confirmRemove: Boolean = false, val saving: Boolean = false)

/**
 * One work order. Plain detail always; with the lock open and a key for the store, `sealed=1` adds the card and the latest snapshot,
 * which are opened in memory only when the work order is opened (never prefetched). Locking drops them immediately.
 */
class WorkOrderDetailViewModel(
    private val repo: WoRepository,
    private val lock: AppLock,
    private val auth: Auth?,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val work: CoroutineDispatcher = Dispatchers.Default,
) : ViewModel() {
    private val _state = MutableStateFlow(WoDetailUi(unlocked = lock.isUnlocked.value))
    val state: StateFlow<WoDetailUi> = _state.asStateFlow()
    private var job: Job? = null

    init {
        viewModelScope.launch { auth?.state?.collect { s -> if (s is AuthState.Registered) _state.update { it.copy(stores = s.stores) } } }
        viewModelScope.launch {
            lock.isUnlocked.collect { unlocked ->
                if (unlocked == _state.value.unlocked) return@collect
                _state.update { it.copy(unlocked = unlocked, sealed = if (unlocked) it.sealed else SealedUi.Locked) }
                if (unlocked && _state.value.key != null) load(keep = true)
            }
        }
    }

    fun show(key: WoKey) {
        if (key == _state.value.key && _state.value.view != LoadView.Error) return
        _state.update { WoDetailUi(key = key, unlocked = it.unlocked, stores = it.stores) }
        load(keep = false)
    }

    fun refresh() = load(keep = true, manual = true)

    private fun load(keep: Boolean, manual: Boolean = false) {
        val key = _state.value.key ?: return
        job?.cancel()
        val opener = lock.opener
        val wantSealed = _state.value.unlocked && opener != null && opener.hasKey(key.store)
        _state.update {
            it.copy(
                view = if (keep && it.detail != null) LoadView.Ok else LoadView.Loading, refreshing = manual, problem = null,
                sealed = when {
                    !it.unlocked || opener == null -> SealedUi.Locked
                    !opener.hasKey(key.store) -> SealedUi.NoKey
                    it.sealed is SealedUi.Shown -> it.sealed
                    else -> SealedUi.Loading
                },
            )
        }
        job = viewModelScope.launch {
            var r = repo.detail(key, sealed = wantSealed)
            var noKey = false
            if (r is ApiResult.Failure && wantSealed && problemOf(r) == Problem.NoKey) { noKey = true; r = repo.detail(key, sealed = false) }
            when (r) {
                is ApiResult.Success -> {
                    val d = r.value
                    val at = nowMs()
                    val sealedUi = when {
                        !_state.value.unlocked -> SealedUi.Locked
                        noKey || !wantSealed -> if (lock.opener == null) SealedUi.Locked else SealedUi.NoKey
                        else -> unseal(key, d)
                    }
                    _state.update {
                        it.copy(
                            view = LoadView.Ok, detail = d.copy(sealed = null), refreshing = false, problem = null, receivedAtMs = at,
                            skewMs = d.now?.let { n -> runCatching { java.time.Instant.parse(n).toEpochMilli() - at }.getOrNull() } ?: 0L,
                            sealed = if (it.unlocked) sealedUi else SealedUi.Locked,
                        )
                    }
                }
                is ApiResult.Failure -> _state.update {
                    val p = problemOf(r)
                    if (it.detail != null) it.copy(view = LoadView.Ok, refreshing = false, problem = p, sealed = if (it.sealed == SealedUi.Loading) SealedUi.Failed else it.sealed)
                    else it.copy(view = LoadView.Error, refreshing = false, problem = p)
                }
            }
        }
    }

    // ---- Waymark: tags and the follow-up (MOBILE-API-waymark.md) ---------------------------------------------------------------

    fun messageShown() = _state.update { it.copy(message = null) }

    fun openTags() {
        val key = _state.value.key ?: return
        if (!_state.value.editable) return
        _state.update { it.copy(tagsSheet = (it.tagsSheet ?: TagsSheetUi()).copy(loading = true, failed = false)) }
        viewModelScope.launch {
            val r = repo.waymarkTags(key.store)
            _state.update { s ->
                val sheet = s.tagsSheet ?: return@update s
                s.copy(tagsSheet = when (r) {
                    is ApiResult.Success -> sheet.copy(loading = false, failed = false, managed = r.value.tags, oneOff = r.value.oneOff, maxTags = r.value.maxTags, maxLength = r.value.maxLength)
                    is ApiResult.Failure -> sheet.copy(loading = false, failed = true)
                })
            }
        }
    }

    fun closeTags() = _state.update { it.copy(tagsSheet = null) }

    /** Turns a tag on or off at once (optimistic); a refusal puts it back and says why in one line. */
    fun toggleTag(name: String, on: Boolean) {
        val s = _state.value
        val key = s.key ?: return
        val wo = s.detail?.wo ?: return
        if (!wo.open) return
        val sheet = s.tagsSheet ?: TagsSheetUi(loading = false)
        val clean = WaymarkTags.clean(name, sheet.maxLength)
        if (clean.isEmpty()) return
        val before = wo.tags
        val existing = WaymarkTags.find(before, clean)
        if (on == (existing != null)) return
        if (clean.lowercase() in sheet.busy) return
        if (on && before.size >= sheet.maxTags) { _state.update { it.copy(message = "${sheet.maxTags} tags at most.") }; return }
        val managed = sheet.managed?.firstOrNull { it.name.equals(clean, ignoreCase = true) }
        val sent = existing?.tag ?: managed?.name ?: clean
        val index = before.indexOf(existing)
        withTags(if (on) before + WoTag(sent, managed?.color) else before - existing!!, busyAdd = sent.lowercase())
        viewModelScope.launch {
            when (val r = repo.setTag(key, sent, on)) {
                is ApiResult.Success -> {
                    withTags(r.value.tags, busyRemove = sent.lowercase())
                    afterWrite()
                }
                is ApiResult.Failure -> {
                    val now = _state.value.detail?.wo?.tags.orEmpty()
                    val back = if (on) now.filterNot { it.tag.equals(sent, ignoreCase = true) }
                    else if (WaymarkTags.find(now, sent) == null) now.toMutableList().apply { add(index.coerceIn(0, size), existing!!) } else now
                    withTags(back, busyRemove = sent.lowercase())
                    _state.update { it.copy(message = waymarkErrorText(r)) }
                    if (r.status == 409) load(keep = true)
                }
            }
        }
    }

    /** A one-off tag typed in the sheet. */
    fun addTag(text: String) = toggleTag(text, true)

    private fun withTags(tags: List<WoTag>, busyAdd: String? = null, busyRemove: String? = null) = _state.update { s ->
        val d = s.detail ?: return@update s
        s.copy(
            detail = d.copy(wo = d.wo.copy(tags = tags)),
            tagsSheet = s.tagsSheet?.let { t -> t.copy(busy = t.busy.let { b -> if (busyAdd != null) b + busyAdd else b }.let { b -> if (busyRemove != null) b - busyRemove else b }) },
        )
    }

    fun openFollowUp() {
        if (!_state.value.editable || _state.value.detail?.wo?.followUp == null) return
        _state.update { it.copy(followSheet = FollowSheetUi()) }
    }

    fun closeFollowUp() = _state.update { it.copy(followSheet = null) }

    fun pickFollowUp(day: LocalDate) = _state.update { s -> s.followSheet?.let { s.copy(followSheet = it.copy(choice = day, confirmRemove = false)) } ?: s }

    /** Moves the follow-up to the picked day. */
    fun saveFollowUp() {
        val key = _state.value.key ?: return
        val sheet = _state.value.followSheet ?: return
        val day = sheet.choice ?: return
        if (sheet.saving) return
        writeFollowUp(key) { repo.pushFollowUp(key, day.toString()) }
    }

    /** First tap arms Remove; the second removes the follow-up for good (Portal's ×). */
    fun removeFollowUp() {
        val key = _state.value.key ?: return
        val sheet = _state.value.followSheet ?: return
        if (sheet.saving) return
        if (!sheet.confirmRemove) { _state.update { it.copy(followSheet = sheet.copy(confirmRemove = true)) }; return }
        writeFollowUp(key) { repo.removeFollowUp(key) }
    }

    private fun writeFollowUp(key: WoKey, call: suspend () -> ApiResult<WaymarkFollowUpResponse>) {
        _state.update { s -> s.copy(followSheet = s.followSheet?.copy(saving = true)) }
        viewModelScope.launch {
            when (val r = call()) {
                is ApiResult.Success -> {
                    _state.update { s ->
                        val d = s.detail ?: return@update s.copy(followSheet = null)
                        s.copy(detail = d.copy(wo = d.wo.copy(followUp = r.value.followUp)), followSheet = null)
                    }
                    afterWrite()
                }
                is ApiResult.Failure -> {
                    _state.update { s -> s.copy(followSheet = s.followSheet?.copy(saving = false, confirmRemove = false), message = waymarkErrorText(r)) }
                    if (r.status == 409 || r.error == ApiError.NotFound) load(keep = true)
                }
            }
        }
    }

    /** After a change: the list updates the row, and the detail is read again. */
    private fun afterWrite() {
        _state.value.detail?.wo?.let(repo::notifyChanged)
        load(keep = true)
    }

    private suspend fun unseal(key: WoKey, d: WoDetailResponse): SealedUi {
        val opener = lock.opener ?: return SealedUi.Locked
        val part = d.sealed
        val cardSealed = part?.card
        val snapSealed = part?.snapshot?.sealed
        if (cardSealed == null && snapSealed == null) return SealedUi.Missing
        return withContext(work) {
            try {
                val card = cardSealed?.let { Card.from(opener.openJson(key.store, it, SealedBox.Aad.card(key.store, key.wo))) }
                val snap = snapSealed?.let { opener.openJson(key.store, it, SealedBox.Aad.snapshot(key.store, key.wo)) }
                SealedUi.Shown(Unsealed.from(card, snap, part?.snapshot?.fetchedAt))
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                SealedUi.Failed
            }
        }
    }
}
