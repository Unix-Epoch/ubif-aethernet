package dev.aethernet.linkpearl.feature.workorders

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
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
) {
    fun storeName(id: Int): String = stores.firstOrNull { it.id == id }?.label ?: "#$id"
}

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
