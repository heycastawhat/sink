package nz.joshp.sink.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import nz.joshp.sink.SinkApp
import nz.joshp.sink.data.pluginsJson
import nz.joshp.sink.data.Api
import nz.joshp.sink.data.ApiException
import nz.joshp.sink.data.NoteMeta
import nz.joshp.sink.data.NoteStore
import nz.joshp.sink.data.Todo
import nz.joshp.sink.data.addTodo
import nz.joshp.sink.data.createNote
import nz.joshp.sink.data.notes
import nz.joshp.sink.data.searchNotes
import nz.joshp.sink.data.todos
import nz.joshp.sink.data.toggleTodo
import nz.joshp.sink.reminders.ReminderSync

data class NotesState(
    val notes: List<NoteMeta> = emptyList(),
    val folders: List<String> = emptyList(),
    val folder: String = "",
    val query: String = "",
    val results: List<NoteMeta>? = null,
    val loaded: Boolean = false,
    val refreshing: Boolean = false,
    /** Showing the copy on the phone because the server can't be reached. */
    val offline: Boolean = false,
    val error: String? = null,
)

data class TodosState(
    val open: List<Todo> = emptyList(),
    val done: List<Todo>? = null,
    val today: String = "",
    val loaded: Boolean = false,
    val refreshing: Boolean = false,
    val error: String? = null,
)

/** The Notes grid and the Todos list. Notes are files on the NAS; this keeps the phone's copy of the list. */
class NotesViewModel(app: Application) : AndroidViewModel(app) {
    private val sinkApp = app as SinkApp
    private val store = NoteStore(app)
    private val _state = MutableStateFlow(NotesState())
    val state: StateFlow<NotesState> = _state.asStateFlow()
    private val _todos = MutableStateFlow(TodosState())
    val todos: StateFlow<TodosState> = _todos.asStateFlow()
    val loggedOut = MutableStateFlow(false)

    private var searchJob: Job? = null

    init {
        store.list()?.let { cached -> _state.update { it.copy(notes = cached.notes, folders = cached.folders, loaded = true) } }
        refresh()
    }

    suspend fun api(): Api? = sinkApp.settings.session.first()?.let(::Api)

    /** Enabled plugins for the editor page; the cached list until the server answers. */
    fun pluginsJson(): String = store.plugins()

    suspend fun logout() {
        runCatching { api()?.logout() }
        sinkApp.settings.clearToken()
    }

    fun refresh(pull: Boolean = false) {
        _state.update { it.copy(refreshing = pull) }
        viewModelScope.launch {
            val api = api() ?: return@launch
            try {
                val list = api.notes()
                store.saveList(list)
                runCatching { store.savePlugins(api.pluginsJson()) }
                _state.update { it.copy(notes = list.notes, folders = list.folders, loaded = true, offline = false, error = null) }
                if (_state.value.query.isNotBlank()) search()
            } catch (e: ApiException) {
                if (e.code == 401) loggedOut.value = true
                _state.update { it.copy(error = e.message, offline = it.loaded, loaded = true) }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                _state.update { it.copy(error = e.message ?: "Can't reach the server", offline = it.loaded, loaded = true) }
            } finally {
                _state.update { it.copy(refreshing = false) }
            }
        }
    }

    fun setFolder(folder: String) = _state.update { it.copy(folder = if (it.folder == folder) "" else folder) }

    fun setQuery(q: String) {
        _state.update { it.copy(query = q, results = if (q.isBlank()) null else it.results) }
        searchJob?.cancel()
        if (q.isBlank()) return
        searchJob = viewModelScope.launch {
            delay(250)
            search()
        }
    }

    private suspend fun search() {
        val q = _state.value.query
        val api = api() ?: return
        // Offline: match titles and the cached excerpts instead.
        val hits = runCatching { api.searchNotes(q) }.getOrElse {
            val words = q.lowercase().split(Regex("\\s+")).filter { it.isNotBlank() }
            _state.value.notes.filter { n -> words.all { w -> n.title.lowercase().contains(w) || n.excerpt.orEmpty().lowercase().contains(w) } }
        }
        if (_state.value.query == q) _state.update { it.copy(results = hits) }
    }

    /** Like Obsidian: by path, then file name, then title. */
    fun resolveLink(target: String): NoteMeta? {
        val name = target.substringBefore('#').removeSuffix(".md").trim()
        val lower = name.lowercase()
        val notes = _state.value.notes
        return notes.firstOrNull { it.path.lowercase() == "$lower.md" }
            ?: notes.firstOrNull { it.fileName.lowercase() == lower.substringAfterLast('/') }
            ?: notes.firstOrNull { it.title.lowercase() == lower }
    }

    /** Following a link to a note that doesn't exist creates it, as Obsidian does. */
    suspend fun createLinked(target: String): NoteMeta? {
        val name = target.substringBefore('#').removeSuffix(".md").trim()
        val title = name.substringAfterLast('/')
        return runCatching {
            api()?.createNote(name.substringBeforeLast('/', ""), title, "# $title\n\n")
        }.getOrNull()?.also { refresh() }
    }

    fun linkTargets(): List<Pair<String, String>> =
        _state.value.notes.filterNot { it.isBoard }.map { it.fileName to it.folder }

    // ---------- todos ----------

    fun loadTodos(pull: Boolean = false) {
        _todos.update { it.copy(refreshing = pull) }
        viewModelScope.launch {
            val api = api() ?: return@launch
            try {
                val open = api.todos("open")
                val done = if (_todos.value.done != null) api.todos("done").todos else null
                _todos.update { it.copy(open = open.todos, done = done, today = open.today, loaded = true, error = null) }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                _todos.update { it.copy(error = e.message ?: "Can't reach the server", loaded = true) }
            } finally {
                _todos.update { it.copy(refreshing = false) }
            }
        }
    }

    fun toggleDone() {
        _todos.update { it.copy(done = if (it.done == null) emptyList() else null) }
        if (_todos.value.done != null) loadTodos()
    }

    /** Ticks straight away on screen, then on the server; a 409 means the line changed, so reload. */
    suspend fun toggle(t: Todo, done: Boolean): String? {
        _todos.update { s ->
            s.copy(open = s.open.map { if (it === t) it.copy(status = if (done) "done" else "open") else it })
        }
        val api = api() ?: return "Signed out"
        val error = runCatching { api.toggleTodo(t, done) }.exceptionOrNull()
        delay(350)
        loadTodos()
        ReminderSync.now(getApplication())
        return when {
            error == null -> null
            error is ApiException && error.code == 409 -> "That todo changed; reloaded"
            else -> error.message ?: "Couldn't save"
        }
    }

    suspend fun addTodo(text: String, due: String?, time: String?): String? {
        val api = api() ?: return "Signed out"
        val error = runCatching { api.addTodo(text, due, time) }.exceptionOrNull()
        loadTodos()
        if (due != null) ReminderSync.now(getApplication())
        return error?.let { it.message ?: "Couldn't add" }
    }
}
