package nz.joshp.sink.data

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.jsonObject
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.TimeUnit

// ---------- models (match server/src/notes.ts and todos.ts) ----------

@Serializable
data class NoteMeta(
    val path: String,
    val title: String,
    val tags: List<String> = emptyList(),
    val mtime: Long = 0,
    val hash: String = "",
    val pinned: Boolean = false,
    val color: String? = null,
    /** Start of the text, on list results. */
    val excerpt: String? = null,
    /** Search hit with `[match]` brackets, on search results. */
    val snippet: String? = null,
) {
    val isBoard get() = path.endsWith(".excalidraw.md", ignoreCase = true)
    val folder get() = path.substringBeforeLast('/', "")
    val fileName get() = path.substringAfterLast('/').removeSuffix(".md").removeSuffix(".excalidraw")
}

@Serializable
data class Note(
    val path: String,
    val title: String = "",
    val hash: String,
    val content: String,
    val mtime: Long = 0,
    val pinned: Boolean = false,
    val color: String? = null,
)

@Serializable
data class NoteList(val notes: List<NoteMeta> = emptyList(), val folders: List<String> = emptyList())

@Serializable
private data class SearchResult(val items: List<NoteMeta> = emptyList())

@Serializable
private data class Conflict(val current: Note? = null)

@Serializable
data class Attached(val path: String, val embed: String)

@Serializable
private data class Trashed(@SerialName("trashed_to") val trashedTo: String)

@Serializable
data class Todo(
    val path: String,
    val line: Int,
    val raw: String,
    val text: String,
    val status: String,
    val due: String? = null,
    @SerialName("remind_at") val remindAt: Long? = null,
    @SerialName("done_on") val doneOn: String? = null,
    @SerialName("note_title") val noteTitle: String = "",
) {
    val open get() = status == "open"
    /** Stable across line moves: same note, same text. */
    val key get() = "$path\n${raw.replace(Regex("""\[[xX ]]"""), "[ ]")}"
}

@Serializable
private data class FolderPath(val path: String)

@Serializable
data class TodoList(val todos: List<Todo> = emptyList(), val today: String = "")

@Serializable
private data class Toggled(val line: Int, val raw: String)

/** Where quick todos go (server/src/todos.ts TODO_FILE). */
const val TODO_NOTE = "Todo.md"

/** Keep's card colours, as the server accepts them. */
val NOTE_COLORS = listOf("red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "brown", "gray")

// ---------- API ----------

private fun Api.pathUrl(endpoint: String, path: String) =
    (base + endpoint).toHttpUrl().newBuilder().addQueryParameter("path", path).build()

private fun Api.authed(url: okhttp3.HttpUrl) = Request.Builder().url(url).header("Authorization", "Bearer $token")

suspend fun Api.notes(): NoteList = call(request("/api/notes").build()) { json.decodeFromString(it) }

suspend fun Api.searchNotes(q: String): List<NoteMeta> {
    val url = (base + "/api/notes").toHttpUrl().newBuilder().addQueryParameter("q", q).addQueryParameter("limit", "100").build()
    return call(authed(url).build()) { json.decodeFromString<SearchResult>(it).items }
}

suspend fun Api.note(path: String): Note = call(authed(pathUrl("/api/notes/file", path)).build()) { json.decodeFromString(it) }

suspend fun Api.saveNote(path: String, content: String, baseHash: String?): NoteMeta {
    val body = buildJsonObject {
        put("content", content)
        if (baseHash == null) put("base_hash", JsonNull) else put("base_hash", baseHash)
    }
    return call(authed(pathUrl("/api/notes/file", path)).put(jsonBody(body)).build()) { json.decodeFromString(it) }
}

suspend fun Api.createNote(folder: String, title: String, content: String): NoteMeta {
    val body = buildJsonObject {
        put("folder", folder)
        put("title", title)
        put("content", content)
    }
    return call(request("/api/notes").post(jsonBody(body)).build()) { json.decodeFromString(it) }
}

/** Pin and colour; `clearColor` sends `color: null`. */
suspend fun Api.noteMeta(path: String, pinned: Boolean? = null, color: String? = null, clearColor: Boolean = false): NoteMeta {
    val body = buildJsonObject {
        pinned?.let { put("pinned", it) }
        if (clearColor) put("color", JsonNull) else color?.let { put("color", it) }
    }
    return call(authed(pathUrl("/api/notes/meta", path)).patch(jsonBody(body)).build()) { json.decodeFromString(it) }
}

suspend fun Api.moveNote(from: String, to: String) {
    val body = buildJsonObject {
        put("from", from)
        put("to", to)
    }
    call(request("/api/notes/move").post(jsonBody(body)).build()) { }
}

/** Moves a note to the trash; returns where it went, for [restoreNote]. */
suspend fun Api.trashNote(path: String): String =
    call(authed(pathUrl("/api/notes/file", path)).delete().build()) { json.decodeFromString<Trashed>(it).trashedTo }

/** Puts a trashed note back (numbered if its name is taken now). */
suspend fun Api.restoreNote(trashPath: String): NoteMeta {
    val body = buildJsonObject { put("path", trashPath) }
    return call(request("/api/notes/trash/restore").post(jsonBody(body)).build()) { json.decodeFromString(it) }
}

/** Creates a folder (and any missing parents); returns its path. */
suspend fun Api.createFolder(path: String): String {
    val body = buildJsonObject { put("path", path) }
    return call(request("/api/notes/folders").post(jsonBody(body)).build()) { json.decodeFromString<FolderPath>(it).path }
}

/** Puts a whole trashed folder back (numbered if its name is taken now); returns where it went. */
suspend fun Api.restoreFolder(trashPath: String): String {
    val body = buildJsonObject { put("path", trashPath) }
    return call(request("/api/notes/trash/restore").post(jsonBody(body)).build()) { json.decodeFromString<FolderPath>(it).path }
}

suspend fun Api.attach(name: String, mime: String, bytes: ByteArray): Attached {
    val form = MultipartBody.Builder().setType(MultipartBody.FORM)
        .addFormDataPart("file", name, bytes.toRequestBody(mime.toMediaType()))
        .build()
    return call(request("/api/notes/attachments").post(form).build()) { json.decodeFromString(it) }
}

/** Blocking: the WebView asks for images on its own thread. */
fun Api.attachmentBytes(ref: String): Pair<String, ByteArray>? {
    val url = (base + "/api/notes/attachment").toHttpUrl().newBuilder()
        .addQueryParameter(if ('/' in ref) "path" else "name", ref)
        .build()
    Http.client.newCall(authed(url).build()).execute().use { res ->
        if (!res.isSuccessful) return null
        return (res.header("content-type") ?: "application/octet-stream") to res.body.bytes()
    }
}

/** The server's enabled plugins, as the JSON array the editor page takes (GET /api/plugins -> "plugins"). */
suspend fun Api.pluginsJson(): String = call(request("/api/plugins").build()) {
    json.parseToJsonElement(it).jsonObject["plugins"]?.toString() ?: "[]"
}

/**
 * Blocking: a file the editor page asks for at https://sink.server/<path> (a plugin's client script, styles or its
 * GET routes), fetched from the server with our token. Only plugin paths; nothing else of the API is reachable.
 */
fun Api.pluginFile(pathAndQuery: String): Triple<Int, String, ByteArray>? {
    if (!pathAndQuery.startsWith("/plugins/") && !pathAndQuery.startsWith("/api/plugins/")) return null
    Http.client.newCall(authed((base + pathAndQuery).toHttpUrl()).build()).execute().use { res ->
        return Triple(res.code, res.header("content-type") ?: "application/octet-stream", res.body.bytes())
    }
}

suspend fun Api.todos(view: String = "open"): TodoList = call(request("/api/todos?view=$view").build()) { json.decodeFromString(it) }

suspend fun Api.toggleTodo(t: Todo, done: Boolean) {
    val body = buildJsonObject {
        put("path", t.path)
        put("line", t.line)
        put("raw", t.raw)
        put("done", done)
    }
    call(request("/api/todos/toggle").post(jsonBody(body)).build()) { json.decodeFromString<Toggled>(it) }
}

suspend fun Api.addTodo(text: String, due: String?, time: String?) {
    val body = buildJsonObject {
        put("text", text)
        due?.let { put("due", it) }
        if (due != null) time?.let { put("time", it) }
    }
    call(request("/api/todos").post(jsonBody(body)).build()) { }
}

// ---------- local copy ----------

/** An edit not yet on the server. [path] null = a new note that has no file yet. */
@Serializable
data class PendingEdit(
    val key: String,
    val path: String?,
    val folder: String = "",
    @SerialName("base_hash") val baseHash: String?,
    val text: String,
    val at: Long = System.currentTimeMillis(),
)

/**
 * Notes as last seen, so the grid and notes open offline, plus edits waiting for the network.
 * Plain JSON files under the app's files dir.
 */
/** Until the server has been asked once: Sink's built-in editor plugins, which ship inside the app anyway. */
private const val DEFAULT_PLUGINS =
    """[{"id":"diagrams","bundled_client":true},{"id":"math","bundled_client":true},{"id":"daily","bundled_client":true}]"""

class NoteStore(context: Context) {
    private val dir = File(context.filesDir, "notes").apply { mkdirs() }
    private val notesDir = File(dir, "content").apply { mkdirs() }
    private val pendingDir = File(dir, "pending").apply { mkdirs() }
    private val listFile = File(dir, "list.json")

    private fun id(s: String) = MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }

    private val pluginsFile = File(dir, "plugins.json")
    /** Last plugin list from the server, so built-in plugins (diagrams, math) still work offline. */
    fun plugins(): String = runCatching { pluginsFile.readText() }.getOrDefault(DEFAULT_PLUGINS)
    fun savePlugins(list: String) = atomic(pluginsFile, list)

    private val openedFile = File(dir, "opened.json")
    private val openedSerializer = MapSerializer(String.serializer(), Long.serializer())

    /** When this phone last opened each note (path -> epoch ms), for Recents. Newest 200 only. */
    fun opened(): Map<String, Long> = runCatching { json.decodeFromString(openedSerializer, openedFile.readText()) }.getOrDefault(emptyMap())

    fun markOpened(path: String, at: Long) = saveOpened(opened() + (path to at))

    /** A note was moved or renamed: its open time follows it. */
    fun renameOpened(from: String, to: String) {
        val map = opened()
        val at = map[from] ?: return
        saveOpened(map - from + (to to at))
    }

    private fun saveOpened(map: Map<String, Long>) =
        atomic(openedFile, json.encodeToString(openedSerializer, map.entries.sortedByDescending { it.value }.take(200).associate { it.key to it.value }))

    fun list(): NoteList? = runCatching { json.decodeFromString<NoteList>(listFile.readText()) }.getOrNull()
    fun saveList(list: NoteList) = atomic(listFile, json.encodeToString(NoteList.serializer(), list))

    fun note(path: String): Note? = runCatching { json.decodeFromString<Note>(File(notesDir, id(path)).readText()) }.getOrNull()
    fun saveNote(note: Note) = atomic(File(notesDir, id(note.path)), json.encodeToString(Note.serializer(), note))
    fun forget(path: String) {
        File(notesDir, id(path)).delete()
    }

    fun pending(key: String): PendingEdit? =
        runCatching { json.decodeFromString<PendingEdit>(File(pendingDir, id(key)).readText()) }.getOrNull()

    fun allPending(): List<PendingEdit> =
        pendingDir.listFiles().orEmpty().mapNotNull { f -> runCatching { json.decodeFromString<PendingEdit>(f.readText()) }.getOrNull() }

    fun putPending(p: PendingEdit) = atomic(File(pendingDir, id(p.key)), json.encodeToString(PendingEdit.serializer(), p))
    fun clearPending(key: String) {
        File(pendingDir, id(key)).delete()
    }

    private fun atomic(file: File, text: String) {
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(text)
        tmp.renameTo(file)
    }
}

/** What a save came to. */
sealed interface SaveResult {
    /** Written; [meta] is the file now. */
    data class Saved(val meta: NoteMeta) : SaveResult
    /** Changed elsewhere: their version is [theirs]; ours went to [copy] (null if theirs already matched ours). */
    data class Conflict(val theirs: Note?, val copy: NoteMeta?, val meta: NoteMeta?) : SaveResult
    /** No network or the NAS is down: kept on the phone, retried by [NoteSync]. */
    data object Offline : SaveResult
    data class Failed(val message: String) : SaveResult
}

/**
 * Saves the way the web app does: the hash we last saw goes with the text, and a mismatch never overwrites.
 * The other side's version wins the file; ours is kept as "<name> (conflict <time>)" beside it.
 */
object NoteSaver {
    /** Saves outlive the screen that started them (leaving a note flushes it). */
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Mutex()

    fun titleFor(text: String): String {
        Regex("""^#\s+(.+)$""", RegexOption.MULTILINE).find(text)?.let { return it.groupValues[1].trim().take(60) }
        // A shared photo on its own is named after the file, not "![[Photo.jpg]]".
        val embed = Regex("""^!\[\[([^\]|]+)[^\]]*]]$""")
        val lines = text.trim().lineSequence().map { it.trim() }.filter { it.isNotEmpty() }.toList()
        val first = lines.firstOrNull { !embed.matches(it) }
            ?: return lines.firstOrNull()?.let { embed.find(it)!!.groupValues[1].substringBeforeLast('.') }.orEmpty().take(60)
        return first.replace(Regex("""^[-*+]\s+(\[.]\s+)?|^#+\s+"""), "").take(60)
    }

    /** [requeue] false from the sync worker itself, which retries through WorkManager instead. */
    suspend fun save(context: Context, api: Api, edit: PendingEdit, requeue: Boolean = true): SaveResult = lock.withLock {
        val store = NoteStore(context)
        try {
            val meta = if (edit.path == null) {
                if (edit.text.isBlank()) return@withLock SaveResult.Saved(NoteMeta("", ""))
                api.createNote(edit.folder, titleFor(edit.text), edit.text)
            } else {
                api.saveNote(edit.path, edit.text, edit.baseHash)
            }
            store.saveNote(Note(meta.path, meta.title, meta.hash, edit.text, meta.mtime, meta.pinned, meta.color))
            store.clearPending(edit.key)
            SaveResult.Saved(meta)
        } catch (e: ApiException) {
            when {
                e.code == 409 && edit.path != null -> resolveConflict(context, api, edit, e.body)
                e.code == 401 || e.code >= 500 -> offline(context, edit, requeue)
                else -> SaveResult.Failed(e.message ?: "Couldn't save")
            }
        } catch (_: IOException) {
            offline(context, edit, requeue)
        }
    }

    private fun offline(context: Context, edit: PendingEdit, requeue: Boolean): SaveResult {
        NoteStore(context).putPending(edit)
        if (requeue) NoteSync.enqueue(context)
        return SaveResult.Offline
    }

    private suspend fun resolveConflict(context: Context, api: Api, edit: PendingEdit, body: String?): SaveResult {
        val store = NoteStore(context)
        val theirs = body?.let { runCatching { json.decodeFromString<Conflict>(it).current }.getOrNull() }
        if (theirs != null && theirs.content == edit.text) {
            store.saveNote(theirs)
            store.clearPending(edit.key)
            return SaveResult.Conflict(theirs, null, NoteMeta(theirs.path, theirs.title, hash = theirs.hash))
        }
        val path = edit.path!!
        val name = path.substringAfterLast('/').removeSuffix(".md")
        val stamp = SimpleDateFormat("yyyy-MM-dd HH-mm", Locale.US).format(Date())
        val copy = api.createNote(path.substringBeforeLast('/', ""), "$name (conflict $stamp)", edit.text)
        store.clearPending(edit.key)
        if (theirs != null) store.saveNote(theirs) else store.forget(path)
        return SaveResult.Conflict(theirs, copy, theirs?.let { NoteMeta(it.path, it.title, hash = it.hash) })
    }

    fun newDraftKey() = "draft:" + UUID.randomUUID()
}

/** Pushes edits made offline once there's a network. */
object NoteSync {
    private const val NAME = "note-sync"

    fun enqueue(context: Context) {
        val req = OneTimeWorkRequestBuilder<NoteSyncWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        // Append: a run already going may have passed this edit by.
        WorkManager.getInstance(context).enqueueUniqueWork(NAME, ExistingWorkPolicy.APPEND_OR_REPLACE, req)
    }
}

class NoteSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val session = Settings(applicationContext).session() ?: return@withContext Result.success()
        val api = Api(session)
        val store = NoteStore(applicationContext)
        var retry = false
        for (edit in store.allPending().sortedBy { it.at }) {
            when (NoteSaver.save(applicationContext, api, edit, requeue = false)) {
                SaveResult.Offline -> retry = true
                else -> Unit
            }
        }
        if (retry) Result.retry() else Result.success()
    }
}
