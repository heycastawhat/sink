package nz.joshp.sink.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
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
import nz.joshp.sink.data.createFolder
import nz.joshp.sink.data.createNote
import nz.joshp.sink.data.moveNote
import nz.joshp.sink.data.restoreFolder
import nz.joshp.sink.data.trashNote
import nz.joshp.sink.data.notes
import nz.joshp.sink.data.restoreNote
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

/** A note (or a whole folder) just moved to the trash, for the list's Undo. */
data class TrashedNote(val title: String, val trashPath: String, val isFolder: Boolean = false)

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
    val trashed = MutableStateFlow<TrashedNote?>(null)

    private var searchJob: Job? = null

    private val _opened = MutableStateFlow(store.opened())
    /** When this phone last opened each note, for Recents. */
    val opened: StateFlow<Map<String, Long>> = _opened.asStateFlow()

    fun markOpened(path: String) {
        store.markOpened(path, System.currentTimeMillis())
        _opened.value = store.opened()
    }

    fun renameOpened(from: String, to: String) {
        store.renameOpened(from, to)
        _opened.value = store.opened()
    }

    init {
        store.list()?.let { cached -> _state.update { it.copy(notes = cached.notes, folders = cached.folders, loaded = true) } }
        refresh()
    }

    suspend fun api(): Api? = sinkApp.settings.session.first()?.let(::Api)

    val hideFoldered: StateFlow<Boolean> = sinkApp.settings.hideFoldered.stateIn(viewModelScope, SharingStarted.Eagerly, false)

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

    /** The folder being browsed: a full path like "Projects/Sink", or "" for all notes. */
    fun setFolder(folder: String) = _state.update { it.copy(folder = folder) }

    /** Up one level; false at the top (so Back can leave the app instead). */
    fun folderUp(): Boolean {
        val f = _state.value.folder
        if (f.isEmpty()) return false
        setFolder(f.substringBeforeLast('/', ""))
        return true
    }

    /**
     * Runs a folder change on the server, then reloads. Returns an error message for the snackbar, or null.
     * Folder changes need the server; offline they fail with a friendly message rather than queueing.
     */
    private suspend fun folderChange(conflict: String, block: suspend (Api) -> Unit): String? {
        val api = api() ?: return "Signed out"
        val error = runCatching { block(api) }.exceptionOrNull()
        refresh()
        return when {
            error == null -> null
            error is ApiException && error.code == 409 -> conflict
            error is ApiException && error.code == 400 -> error.message ?: "That doesn't work as a folder name"
            error is ApiException -> error.message ?: "Couldn't change the folder"
            else -> "You're offline. Folder changes need the server."
        }
    }

    /** New folder named [name] inside [parent]; opens it. */
    suspend fun newFolder(parent: String, name: String): String? {
        val path = listOf(parent, name.trim().trim('/')).filter { it.isNotEmpty() }.joinToString("/")
        return folderChange("That folder already exists") { api ->
            val made = api.createFolder(path)
            setFolder(made)
        }
    }

    /** Creates [path] (from the top level) for the move picker: the created path, or null and an error message. */
    suspend fun createFolderAt(path: String): Pair<String?, String?> {
        var made: String? = null
        val error = folderChange("That folder already exists") { api -> made = api.createFolder(path.trim().trim('/')) }
        return made to error
    }

    /** Renames the folder being browsed, in place. */
    suspend fun renameFolder(from: String, name: String): String? {
        val to = listOf(from.substringBeforeLast('/', ""), name.trim().trim('/')).filter { it.isNotEmpty() }.joinToString("/")
        if (to == from) return null
        return folderChange("A folder with that name is already there") { api ->
            api.moveNote(from, to)
            setFolder(to)
        }
    }

    /** Moves the folder [from] into [parent] ("" for the top level), keeping its name. */
    suspend fun moveFolder(from: String, parent: String): String? {
        val to = listOf(parent, from.substringAfterLast('/')).filter { it.isNotEmpty() }.joinToString("/")
        if (to == from) return null
        return folderChange("A folder with that name is already there") { api ->
            api.moveNote(from, to)
            setFolder(to)
        }
    }

    /** Moves a folder and everything in it to the trash; the list offers Undo. */
    suspend fun trashFolder(path: String): String? = folderChange("Couldn't delete that folder") { api ->
        val trashPath = api.trashNote(path)
        setFolder(path.substringBeforeLast('/', ""))
        trashed.value = TrashedNote(path.substringAfterLast('/'), trashPath, isFolder = true)
    }

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

    /** Called by the note screen after a delete; the list then offers Undo. */
    fun trashed(path: String, trashPath: String) {
        val title = _state.value.notes.firstOrNull { it.path == path }?.title ?: path.substringAfterLast('/').removeSuffix(".md")
        _state.update { s -> s.copy(notes = s.notes.filterNot { it.path == path }, results = s.results?.filterNot { it.path == path }) }
        trashed.value = TrashedNote(title, trashPath)
        refresh()
    }

    /** Puts the note back; returns an error message, or null. */
    suspend fun undoTrash(note: TrashedNote): String? {
        val api = api() ?: return "Signed out"
        val error = runCatching {
            if (note.isFolder) api.restoreFolder(note.trashPath) else api.restoreNote(note.trashPath)
        }.exceptionOrNull()
        refresh()
        return error?.let { "Couldn't restore: ${it.message}" }
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

    /** A blank Excalidraw board in Boards/, named for now: its path, or null and an error message. */
    suspend fun newBoard(): Pair<String?, String?> {
        val api = api() ?: return null to "Signed out"
        val title = "Drawing ${java.time.LocalDateTime.now().format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH.mm"))}.excalidraw"
        val made = runCatching { api.createNote("Boards", title, EMPTY_BOARD) }
        refresh()
        return made.fold({ it.path to null }, { null to (if (it is ApiException) it.message ?: "Couldn't make a board" else "You're offline. Boards need the server.") })
    }
}

/** What the web app writes for a new board (web/src/board.js): the Obsidian Excalidraw plugin's file, empty. */
private val EMPTY_BOARD = listOf(
    "---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---",
    "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'",
    "",
    "",
    "# Excalidraw Data",
    "",
    "## Text Elements",
    "",
    "%%",
    "## Drawing",
    "```json",
    "{\n\t\"elements\": [],\n\t\"appState\": {},\n\t\"files\": {}\n}",
    "```",
    "%%",
    "",
).joinToString("\n")
