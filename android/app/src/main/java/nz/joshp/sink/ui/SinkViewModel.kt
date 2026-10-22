package nz.joshp.sink.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.work.WorkManager
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import nz.joshp.sink.SinkApp
import nz.joshp.sink.capture.UPLOAD_TAG
import nz.joshp.sink.data.Api
import nz.joshp.sink.data.ApiException
import nz.joshp.sink.data.Capture
import nz.joshp.sink.data.Page
import nz.joshp.sink.data.SinkCollection

enum class View(val id: String, val label: String) {
    All("all", "Sink"),
    Review("digest", "Review"),
    Pinned("pinned", "Pinned"),
    Archived("archived", "Archive"),
    Trash("trash", "Trash"),
}

data class SinkState(
    val view: View = View.All,
    val kind: String? = null,
    val collection: String? = null,
    val collections: List<SinkCollection> = emptyList(),
    val reviewCount: Int = 0,
    val query: String = "",
    val items: List<Capture> = emptyList(),
    val cursor: String? = null,
    val done: Boolean = false,
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val error: String? = null,
)

class SinkViewModel(app: Application) : AndroidViewModel(app) {
    private val sinkApp = app as SinkApp
    private val _state = MutableStateFlow(SinkState())
    val state: StateFlow<SinkState> = _state.asStateFlow()

    val loggedOut = MutableStateFlow(false)

    /** How many captures are queued on the phone, waiting to upload. */
    val uploading: StateFlow<Int> = WorkManager.getInstance(app).getWorkInfosByTagFlow(UPLOAD_TAG)
        .map { infos -> infos.count { !it.state.isFinished } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0)

    private var loadJob: Job? = null
    private var searchJob: Job? = null
    private var pollJob: Job? = null
    private var lastUploading = 0

    init {
        reload()
        loadCollections()
        refreshReviewCount()
        // When the queue drains, new captures exist on the server.
        viewModelScope.launch {
            uploading.collect { n ->
                if (n < lastUploading) reload(quiet = true)
                lastUploading = n
            }
        }
    }

    private suspend fun api(): Api? = sinkApp.settings.session.first()?.let(::Api)

    /** What a screen shows: a view, optionally inside a collection. Called by each screen as it appears. */
    fun show(view: View, collection: String? = null) {
        val s = _state.value
        if (s.view == view && s.collection == collection) return
        _state.update { it.copy(view = view, collection = collection, kind = null, query = "") }
        reload()
    }

    fun refreshReviewCount() {
        viewModelScope.launch {
            val n = runCatching { api()?.digest()?.size }.getOrNull() ?: return@launch
            _state.update { it.copy(reviewCount = n) }
        }
    }

    fun setKind(kind: String?) {
        _state.update { it.copy(kind = if (it.kind == kind) null else kind) }
        reload()
    }

    fun setQuery(q: String) {
        _state.update { it.copy(query = q) }
        searchJob?.cancel()
        searchJob = viewModelScope.launch {
            delay(250)
            reload()
        }
    }

    fun refresh() = reload(pull = true)

    fun reload(quiet: Boolean = false, pull: Boolean = false) {
        loadJob?.cancel()
        if (!quiet) _state.update { it.copy(items = if (pull) it.items else emptyList(), cursor = null, done = false, error = null) }
        _state.update { it.copy(refreshing = pull) }
        loadJob = viewModelScope.launch { load(reset = true) }
    }

    fun loadMore() {
        val s = _state.value
        if (s.loading || s.done || loadJob?.isActive == true) return
        loadJob = viewModelScope.launch { load(reset = false) }
    }

    private suspend fun load(reset: Boolean) {
        val api = api() ?: return
        val s = _state.value
        _state.update { it.copy(loading = true) }
        try {
            // Review is one short list from the digest; filters and paging don't apply.
            val page = if (s.view == View.Review) Page(api.digest())
            else api.list(s.query, s.kind, s.collection, s.view.id, if (reset) null else s.cursor)
            _state.update {
                it.copy(
                    items = if (reset) page.items else it.items + page.items,
                    cursor = page.nextCursor,
                    done = page.nextCursor == null,
                    error = null,
                )
            }
            schedulePoll()
        } catch (e: ApiException) {
            if (e.code == 401) loggedOut.value = true
            _state.update { it.copy(error = e.message) }
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            _state.update { it.copy(error = e.message ?: "Couldn't reach the server") }
        } finally {
            _state.update { it.copy(loading = false, refreshing = false) }
        }
    }

    /** Re-fetch captures the AI is still reading until they settle. */
    private fun schedulePoll() {
        pollJob?.cancel()
        pollJob = viewModelScope.launch {
            while (true) {
                val busy = _state.value.items.filter { it.busy }.take(20)
                if (busy.isEmpty()) return@launch
                delay(3000)
                val api = api() ?: return@launch
                for (c in busy) {
                    runCatching { api.get(c.id) }.getOrNull()?.let { replace(it) }
                }
            }
        }
    }

    fun replace(capture: Capture) {
        _state.update { s -> s.copy(items = s.items.map { if (it.id == capture.id) capture else it }) }
    }

    fun remove(id: String) {
        _state.update { s -> s.copy(items = s.items.filterNot { it.id == id }) }
    }

    // ---- collections ----

    fun loadCollections() {
        viewModelScope.launch {
            val list = runCatching { api()?.collections() }.getOrNull() ?: return@launch
            val gone = _state.value.collection?.let { id -> list.none { it.id == id } } == true
            _state.update { it.copy(collections = list, collection = if (gone) null else it.collection) }
            if (gone) reload()
        }
    }

    suspend fun createCollection(name: String): Result<SinkCollection> = collectionCall {
        it.createCollection(name).also { loadCollections() }
    }

    suspend fun renameCollection(id: String, name: String): Result<SinkCollection> = collectionCall {
        it.renameCollection(id, name).also { loadCollections() }
    }

    suspend fun deleteCollection(id: String): Result<Unit> = collectionCall {
        it.deleteCollection(id)
        loadCollections()
    }

    private suspend fun <T> collectionCall(block: suspend (Api) -> T): Result<T> {
        val api = api() ?: return Result.failure(IllegalStateException("Signed out"))
        return runCatching { block(api) }.recoverCatching { e ->
            throw if (e is ApiException && e.code == 409) IllegalArgumentException("That name's taken") else e
        }
    }

    /** Sets the full membership; drops the card if it left the collection being browsed. */
    suspend fun setCollections(id: String, ids: List<String>): Capture? {
        val body = buildJsonObject { put("collections", JsonArray(ids.map(::JsonPrimitive))) }
        val updated = runCatching { api()?.patch(id, body) }.getOrNull() ?: return null
        replace(updated)
        _state.value.collection?.let { if (it !in updated.collections.orEmpty()) remove(id) }
        loadCollections()
        return updated
    }

    /** Review: keep (seen, stays in the sink) or archive. */
    fun review(id: String, archive: Boolean) {
        remove(id)
        _state.update { it.copy(reviewCount = (it.reviewCount - 1).coerceAtLeast(0)) }
        viewModelScope.launch {
            val body = buildJsonObject {
                put("reviewed", JsonPrimitive(true))
                if (archive) put("archived", JsonPrimitive(true))
            }
            runCatching { api()?.patch(id, body) }
        }
    }

    // ---- detail ----

    suspend fun get(id: String): Capture? = runCatching { api()?.get(id) }.getOrNull()

    suspend fun patch(id: String, body: JsonObject): Capture? =
        runCatching { api()?.patch(id, body) }.getOrNull()?.also(::replace)

    suspend fun reprocess(id: String): Capture? =
        runCatching { api()?.reprocess(id) }.getOrNull()?.also { replace(it); schedulePoll() }

    suspend fun purge(id: String): Boolean = runCatching { api()?.purge(id) }.isSuccess.also { if (it) remove(id) }

    suspend fun actionDone(id: String) {
        runCatching { api()?.setAction(id, state = "done") }
    }

    suspend fun actionAccepted(id: String) {
        runCatching { api()?.setAction(id, state = "accepted") }
    }

    suspend fun logout() {
        runCatching { api()?.logout() }
        sinkApp.settings.clearToken()
    }
}
