package nz.joshp.sink.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.ui.unit.IntSize
import android.annotation.SuppressLint
import android.content.Context
import android.view.inputmethod.InputMethodManager
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.rememberScrollState
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.material.icons.automirrored.outlined.FormatIndentDecrease
import androidx.compose.material.icons.automirrored.outlined.FormatIndentIncrease
import androidx.compose.material.icons.automirrored.outlined.FormatListBulleted
import androidx.compose.material.icons.automirrored.outlined.Redo
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.outlined.CheckBox
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.FormatBold
import androidx.compose.material.icons.outlined.FormatItalic
import androidx.compose.material.icons.outlined.FormatListNumbered
import androidx.compose.material.icons.outlined.FormatQuote
import androidx.compose.material.icons.outlined.KeyboardHide
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.StrikethroughS
import android.content.Intent
import android.graphics.Color as AndroidColor
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.outlined.AddPhotoAlternate
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Unarchive
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.DriveFileRenameOutline
import androidx.compose.material.icons.automirrored.outlined.DriveFileMove
import androidx.compose.material.icons.outlined.FormatColorReset
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.OpenInBrowser
import androidx.compose.material.icons.outlined.Palette
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import nz.joshp.sink.data.backlinksJson
import nz.joshp.sink.data.pluginFile
import nz.joshp.sink.data.saveNote
import nz.joshp.sink.data.templatesIn
import nz.joshp.sink.data.Api
import nz.joshp.sink.data.ApiException
import nz.joshp.sink.data.NOTE_COLORS
import nz.joshp.sink.data.Note
import nz.joshp.sink.data.NoteSaver
import nz.joshp.sink.data.NoteStore
import nz.joshp.sink.data.PendingEdit
import nz.joshp.sink.data.SaveResult
import nz.joshp.sink.data.attach
import nz.joshp.sink.data.attachmentBytes
import nz.joshp.sink.data.json
import nz.joshp.sink.data.moveNote
import nz.joshp.sink.data.note
import nz.joshp.sink.data.noteMeta
import nz.joshp.sink.data.trashNote
import java.io.ByteArrayInputStream
import java.io.File
import nz.joshp.sink.capture.SharedFiles
import java.security.MessageDigest

private const val SAVE_DELAY_MS = 700L
// A new note's file is named on its first save, so give the first line time to be written.
private const val DRAFT_DELAY_MS = 3000L
private const val POLL_MS = 30_000L
private const val EDITOR_URL = "https://appassets.androidplatform.net/editor.html"

/** The editor page's callbacks (see web/src/embed-editor.js). They arrive on a binder thread. */
private class Bridge(
    val onReady: () -> Unit,
    val onChanged: (String) -> Unit,
    val onLink: (String) -> Unit,
    val onPickImage: () -> Unit,
    val onPickTemplate: () -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())

    @JavascriptInterface fun ready() = main.post(onReady).let { }
    @JavascriptInterface fun changed(text: String) = main.post { onChanged(text) }.let { }
    @JavascriptInterface fun openLink(target: String) = main.post { onLink(target) }.let { }
    @JavascriptInterface fun pickImage() = main.post(onPickImage).let { }
    @JavascriptInterface fun pickTemplate() = main.post(onPickTemplate).let { }
}

private enum class TemplateAsk { Slash, Menu }

/** The app's Material colours as the CSS variables the editor styles use. */
private fun ColorScheme.css() = mapOf(
    "--md-sys-color-primary" to primary,
    "--md-sys-color-on-surface" to onSurface,
    "--md-sys-color-on-surface-variant" to onSurfaceVariant,
    "--md-sys-color-surface-container-high" to surfaceContainerHigh,
    "--md-sys-color-surface-container" to surfaceContainer,
    "--md-sys-color-secondary-container" to secondaryContainer,
    "--md-sys-color-on-secondary-container" to onSecondaryContainer,
    "--md-sys-color-error" to error,
    "--md-sys-color-shadow" to scrim,
    "--md-sys-color-outline-variant" to outlineVariant,
).mapValues { (_, c) -> "#%06X".format(c.toArgb() and 0xFFFFFF) }

/** What the note screen tracks between saves. Not Compose state: the WebView owns the text. */
private class Editing(var path: String?, val draftKey: String, var folder: String) {
    var hash: String? = null
    /** Text as last confirmed on the server (or loaded). */
    var saved: String = ""
    /** Latest text from the editor. */
    var current: String = ""
    /** Text handed to the offline queue, to recognise it once the sync worker has saved it. */
    var queued: String? = null
    var loaded = false
    val key get() = path ?: draftKey
    val dirty get() = loaded && current != saved
}

/**
 * One note, fullscreen. The text editor is the web app's CodeMirror page in a WebView (bundled in the APK, so it
 * works offline); this screen owns loading, saving and the network. Boards open in the browser instead.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun NoteScreen(
    vm: NotesViewModel,
    path: String?,
    line: Int?,
    folder: String,
    serverUrl: String,
    onBack: () -> Unit,
    onOpenNote: (String) -> Unit,
    /** Opens the quick switcher. */
    onSwitch: () -> Unit = {},
    /** For a new note: text to start with, e.g. shared from another app. */
    initialText: String = "",
    /** For a new note: photos and PDFs shared from another app (copies in the cache), uploaded and embedded. */
    sharedFiles: List<File> = emptyList(),
) {
    if (path != null && path.endsWith(".excalidraw.md", ignoreCase = true)) {
        BoardScreen(path, serverUrl, onBack)
        return
    }

    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    val motion = MaterialTheme.motionScheme
    val snackbar = remember { SnackbarHostState() }
    val store = remember { NoteStore(context) }
    val draftKey = rememberSaveable { NoteSaver.newDraftKey() }
    // A new note goes in the folder being browsed, unless it was opened for a specific one.
    val ed = remember(path) { Editing(path, draftKey, if (path == null && folder.isEmpty()) vm.state.value.folder else folder) }
    val colors = MaterialTheme.colorScheme
    val dark = colors.surface.luminance() < 0.5f

    var status by remember { mutableStateOf("") }
    var pinned by remember { mutableStateOf(false) }
    var color by remember { mutableStateOf<String?>(null) }
    var crumb by remember { mutableStateOf(path?.substringBeforeLast('/', "")?.ifEmpty { "Notes" } ?: "New note") }
    var menu by remember { mutableStateOf(false) }
    var palette by remember { mutableStateOf(false) }
    var moving by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var history by remember { mutableStateOf(false) }
    var sharing by remember { mutableStateOf(false) }
    // Picking a template to drop in: from /template (the page waits for an answer) or the menu.
    var templating by remember { mutableStateOf<TemplateAsk?>(null) }
    var web by remember { mutableStateOf<WebView?>(null) }
    var pageReady by remember { mutableStateOf(false) }
    var loadedNote by remember { mutableStateOf<String?>(null) }
    var saveJob by remember { mutableStateOf<Job?>(null) }
    val saveLock = remember { Mutex() }

    fun js(code: String) = web?.evaluateJavascript(code, null)
    fun setEditorText(text: String) = js("window.sink.setText(${JsonPrimitive(text)})")

    suspend fun api(): Api? = vm.api()

    fun applyMeta(n: Note) {
        pinned = n.pinned
        color = n.color
        crumb = n.path.substringBeforeLast('/', "").ifEmpty { "Notes" }
    }

    /**
     * One save of the editor's current text; mirrors web/src/notes.js doSave. One at a time, and never cancelled
     * half way: a save cut off after the server wrote would lose the new hash and make the next save a false conflict.
     */
    suspend fun saveNow() {
        // A new note queued offline that the sync worker has since created: carry on in that file, not a second one.
        if (ed.path == null && ed.queued != null) {
            store.takeCreated(ed.key)?.let(store::note)?.let { n ->
                ed.path = n.path
                ed.hash = n.hash
                if (n.content == ed.queued) ed.saved = n.content
                ed.queued = null
                crumb = n.path.substringBeforeLast('/', "").ifEmpty { "Notes" }
            }
        }
        val text = ed.current
        if (!ed.loaded || text == ed.saved) {
            if (ed.loaded) status = "Saved"
            return
        }
        val p = ed.path
        if (p == null && text.isBlank()) return
        // The sync worker may have saved our queued text since: carry on from the hash it got.
        if (p != null && ed.queued != null) {
            store.note(p)?.let { if (it.content == ed.queued) ed.hash = it.hash }
            if (store.pending(p) == null) ed.queued = null
        }
        status = "Saving…"
        val api = api() ?: return
        val result = NoteSaver.save(context, api, PendingEdit(ed.key, p, ed.folder, ed.hash, text))
        when (result) {
            is SaveResult.Saved -> {
                if (ed.path == null) {
                    ed.path = result.meta.path
                    crumb = result.meta.folder.ifEmpty { "Notes" }
                }
                ed.hash = result.meta.hash
                ed.saved = text
                status = if (ed.current == text) "Saved" else "Editing…"
                vm.refresh()
            }
            is SaveResult.Conflict -> {
                val theirs = result.theirs
                if (result.copy == null && theirs != null) {
                    ed.hash = theirs.hash
                    ed.saved = text
                    status = "Saved"
                } else if (theirs != null) {
                    ed.hash = theirs.hash
                    ed.saved = theirs.content
                    ed.current = theirs.content
                    applyMeta(theirs)
                    setEditorText(theirs.content)
                    status = "Saved"
                    snackbar.showSnackbar("Changed somewhere else. Your version was saved as “${result.copy?.fileName}”.")
                } else {
                    // Deleted elsewhere: keep going in the copy.
                    result.copy?.let {
                        ed.path = it.path
                        ed.hash = it.hash
                        ed.saved = text
                    }
                    status = "Saved"
                    snackbar.showSnackbar("That note was deleted elsewhere. Kept yours as “${result.copy?.fileName}”.")
                }
                vm.refresh()
            }
            SaveResult.Offline -> {
                ed.queued = text
                status = "Offline, will save"
            }
            is SaveResult.Failed -> {
                status = "Can't save"
                snackbar.showSnackbar(result.message)
            }
        }
    }

    suspend fun save(): Unit = withContext(NonCancellable) { saveLock.withLock { saveNow() } }

    fun scheduleSave() {
        saveJob?.cancel()
        saveJob = scope.launch {
            delay(if (ed.path == null) DRAFT_DELAY_MS else SAVE_DELAY_MS)
            save()
        }
    }

    fun readAndSave(w: WebView, then: () -> Unit) {
        w.evaluateJavascript("window.sink.getText()") { raw ->
            val text = runCatching { json.decodeFromString<String>(raw) }.getOrNull()
            if (text != null) ed.current = text
            saveJob?.cancel()
            if (ed.dirty && !(ed.path == null && ed.current.isBlank())) {
                val app = context.applicationContext
                NoteSaver.scope.launch {
                    // After any save still in flight, so the hash is the one it got back.
                    saveLock.withLock {
                        if (!ed.dirty) return@withLock
                        val edit = PendingEdit(ed.key, ed.path, ed.folder, ed.hash, ed.current)
                        val result = vm.api()?.let { NoteSaver.save(app, it, edit) }
                        // The screen may still be open (saved on pause): carry on from this file and hash.
                        if (result is SaveResult.Saved) {
                            ed.path = ed.path ?: result.meta.path
                            ed.hash = result.meta.hash
                            ed.saved = edit.text
                        }
                    }
                }
            }
            then()
        }
    }

    /**
     * Pulls the very latest text out of the page and saves it, even if this screen is gone by then. Blurring first makes
     * the keyboard commit the word it's still composing, which the editor's text doesn't include yet.
     */
    fun flush(then: () -> Unit = {}) {
        val w = web
        if (w == null || !ed.loaded) return then()
        w.evaluateJavascript("document.activeElement && document.activeElement.blur()", null)
        w.postDelayed({ readAndSave(w, then) }, 120)
    }

    fun flushAndLeave() = flush(onBack)

    val keyboardUp = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    fun hideKeyboard() {
        val w = web ?: return
        w.evaluateJavascript("document.activeElement && document.activeElement.blur()", null)
        (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(w.windowToken, 0)
    }

    // Switching apps or locking the phone saves too.
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_PAUSE) flush()
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }

    BackHandler { flushAndLeave() }

    // Load: the phone's copy first (works offline), then the server's.
    LaunchedEffect(path) {
        if (path == null) {
            val embeds = mutableListOf<String>()
            val failed = mutableListOf<String>()
            if (sharedFiles.isNotEmpty()) status = "Uploading…"
            for (f in sharedFiles) {
                // Gone already: the screen was rebuilt after uploading it.
                if (!f.isFile) continue
                runCatching {
                    val bytes = withContext(Dispatchers.IO) { f.readBytes() }
                    api()!!.attach(f.name, SharedFiles.mimeOf(f), bytes)
                }.onSuccess { embeds += it.embed }.onFailure { failed += f.name }
                SharedFiles.discard(f)
            }
            status = ""
            if (failed.isNotEmpty()) {
                val what = failed.singleOrNull()?.let { "“$it”" } ?: "${failed.size} files"
                scope.launch { snackbar.showSnackbar("Couldn't upload $what. Share again when you're online.") }
            }
            val start = listOf(initialText.trimEnd(), embeds.joinToString("\n")).filter { it.isNotEmpty() }.joinToString("\n\n")
                .let { if (it.isEmpty()) it else it + "\n" }
            ed.loaded = true
            ed.current = start
            loadedNote = start
            if (start.isNotBlank()) scheduleSave()
            return@LaunchedEffect
        }
        vm.markOpened(path)
        val pending = store.pending(path)
        store.note(path)?.let { cached ->
            ed.hash = cached.hash
            ed.saved = cached.content
            applyMeta(cached)
        }
        val fresh = runCatching { api()?.note(path) }
        fresh.getOrNull()?.let { n ->
            store.saveNote(n)
            ed.hash = n.hash
            ed.saved = n.content
            applyMeta(n)
            status = "Edited ${relativeTime(n.mtime)}"
        }
        val err = fresh.exceptionOrNull()
        if (err is ApiException && err.code == 404) {
            snackbar.showSnackbar("That note is gone")
            onBack()
            return@LaunchedEffect
        }
        if (fresh.getOrNull() == null && store.note(path) == null) {
            status = "Offline"
            snackbar.showSnackbar("Can't open this note offline yet")
            return@LaunchedEffect
        }
        if (fresh.getOrNull() == null) status = "Offline copy"
        // Unsaved edits from before: show them, and save (a stale base becomes a conflict copy, never an overwrite).
        val start = pending?.let {
            ed.hash = it.baseHash
            ed.queued = it.text
            it.text
        } ?: ed.saved
        ed.current = start
        ed.loaded = true
        loadedNote = start
        if (start != ed.saved) scheduleSave()
    }

    // The page and the note can arrive in either order; load once both are here.
    LaunchedEffect(pageReady, loadedNote) {
        val text = loadedNote ?: return@LaunchedEffect
        if (!pageReady) return@LaunchedEffect
        val payload = buildJsonObject {
            put("text", text)
            put("dark", dark)
            putJsonObject("colors") { colors.css().forEach { (k, v) -> put(k, v) } }
            put("links", buildJsonArray {
                vm.linkTargets().forEach { (label, detail) -> add(buildJsonObject { put("label", label); put("detail", detail) }) }
            })
            if (line != null) put("line", line)
            put("plugins", Json.parseToJsonElement(vm.pluginsJson()))
        }
        js("window.sink.load($payload)")
        // Linked mentions after the text, so a slow or offline server never holds the note up.
        val p = ed.path ?: return@LaunchedEffect
        val items = runCatching { api()?.backlinksJson(p) }.getOrNull() ?: return@LaunchedEffect
        js("window.sink.backlinks($items)")
    }

    // Edits made elsewhere show up while the note sits open and untouched: at once from the live stream, and by a
    // slower poll in case that's down.
    suspend fun refreshOpen() {
        val p = ed.path ?: return
        if (ed.dirty || saveJob?.isActive == true || store.pending(p) != null) return
        val n = runCatching { api()?.note(p) }.getOrNull() ?: return
        if (n.hash != ed.hash && !ed.dirty) {
            store.saveNote(n)
            ed.hash = n.hash
            ed.saved = n.content
            ed.current = n.content
            applyMeta(n)
            setEditorText(n.content)
            status = "Updated ${relativeTime(n.mtime)}"
        }
    }
    LaunchedEffect(path, pageReady) {
        while (pageReady) {
            delay(POLL_MS)
            refreshOpen()
        }
    }
    LaunchedEffect(pageReady) {
        if (!pageReady) return@LaunchedEffect
        vm.changes.collect { c -> if (c.path == ed.path || c.from == ed.path) refreshOpen() }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            status = "Uploading…"
            val result = runCatching {
                val (name, mime, bytes) = withContext(Dispatchers.IO) { readPicked(context, uri) }
                api()!!.attach(name, mime, bytes)
            }
            result.onSuccess { js("window.sink.insert(${JsonPrimitive(it.embed)})") }
                .onFailure { snackbar.showSnackbar("Upload failed: ${it.message}") }
            status = ""
        }
    }

    fun openLink(target: String) {
        if (Regex("^(https?:|mailto:)", RegexOption.IGNORE_CASE).containsMatchIn(target)) {
            runCatching { CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(target)) }
                .onFailure { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(target))) }
            return
        }
        scope.launch {
            saveJob?.cancel()
            save()
            val hit = vm.resolveLink(target) ?: vm.createLinked(target)
            if (hit != null) onOpenNote(hit.path) else snackbar.showSnackbar("Couldn't open “$target”")
        }
    }

    /**
     * Puts an earlier version back. The text it replaces is kept as a version too, so a restore can be undone. Runs
     * under the save lock after saving what's on screen, so no autosave races it; refused while an offline edit is
     * still queued, since replaying that later would fight the restored text.
     */
    fun restore(text: String) {
        history = false
        val w = web ?: return
        w.evaluateJavascript("window.sink.getText()") { raw ->
            runCatching { json.decodeFromString<String>(raw) }.getOrNull()?.let { ed.current = it }
            saveJob?.cancel()
            scope.launch {
                saveLock.withLock {
                    val p = ed.path ?: return@withLock
                    val api = api() ?: return@withLock
                    if (ed.dirty) {
                        val r = NoteSaver.save(context, api, PendingEdit(ed.key, p, ed.folder, ed.hash, ed.current))
                        if (r is SaveResult.Saved) {
                            ed.hash = r.meta.hash
                            ed.saved = ed.current
                        }
                    }
                    if (ed.queued != null || store.pending(ed.key) != null || ed.dirty) {
                        snackbar.showSnackbar("Your latest edits haven't reached the server yet. Try again once they have.")
                        return@withLock
                    }
                    runCatching { api.saveNote(p, text, ed.hash, keepVersion = true) }
                        .onSuccess { m ->
                            store.saveNote(Note(m.path, m.title, m.hash, text, m.mtime, m.pinned, m.color))
                            ed.hash = m.hash
                            ed.saved = text
                            ed.current = text
                            setEditorText(text)
                            status = "Restored"
                            vm.refresh()
                        }
                        .onFailure {
                            snackbar.showSnackbar(
                                if ((it as? ApiException)?.code == 409) "This note changed elsewhere just now. Try again."
                                else "Couldn't restore: ${it.message}",
                            )
                        }
                }
            }
        }
    }

    /** Keep's Archive: moves the note into Archive/ (or, from there, back to the top level) and leaves the note. */
    fun archive() {
        saveJob?.cancel()
        val p = ed.path ?: return
        val name = p.substringAfterLast('/')
        val archived = p.startsWith("Archive/", ignoreCase = true)
        val dest = if (archived) name else "Archive/$name"
        flush {
            scope.launch {
                save()
                runCatching { api()!!.moveNote(p, dest) }
                    .onSuccess {
                        store.forget(p)
                        vm.renameOpened(p, dest)
                        ed.saved = ed.current
                        vm.refresh()
                        onBack()
                    }
                    .onFailure {
                        snackbar.showSnackbar(
                            when {
                                it is ApiException && it.code == 409 -> "There's already a note called “${name.removeSuffix(".md")}” there"
                                it is ApiException -> it.message ?: "Couldn't archive"
                                else -> "You're offline. Archiving needs the server."
                            },
                        )
                    }
            }
        }
    }

    /** No "are you sure?": the notes list offers Undo, and the web's Trash page has it after that. */
    fun trash() {
        saveJob?.cancel()
        val p = ed.path ?: return onBack()
        // Saved first, so what comes back from the trash is what was on screen.
        flush {
            scope.launch {
                save()
                runCatching { api()!!.trashNote(p) }
                    .onSuccess { trashedTo ->
                        store.forget(p)
                        store.clearPending(p)
                        ed.saved = ed.current
                        vm.trashed(p, trashedTo)
                        onBack()
                    }
                    .onFailure { snackbar.showSnackbar(it.message ?: "Couldn't delete") }
            }
        }
    }

    suspend fun setMeta(pin: Boolean? = null, newColor: String? = null, clearColor: Boolean = false) {
        saveJob?.cancel()
        save()
        val p = ed.path ?: return snackbar.showSnackbar("Write something first").let { }
        runCatching {
            val api = api()!!
            api.noteMeta(p, pin, newColor, clearColor)
            val n = api.note(p)
            store.saveNote(n)
            ed.hash = n.hash
            ed.saved = n.content
            if (!ed.dirty || ed.current == ed.saved) {
                ed.current = n.content
                setEditorText(n.content)
            }
            applyMeta(n)
            vm.refresh()
        }.onFailure { snackbar.showSnackbar(it.message ?: "Couldn't change it") }
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(noteTint(color, MaterialTheme.colorScheme.surfaceContainerLowest, 0.16f)),
    ) {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()) {
            AndroidView(
                factory = { ctx -> editorWebView(ctx, vm, Bridge(
                    onReady = { pageReady = true },
                    onChanged = { text ->
                        if (ed.loaded) {
                            ed.current = text
                            status = "Editing…"
                            scheduleSave()
                        }
                    },
                    onLink = ::openLink,
                    onPickImage = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                    onPickTemplate = { templating = TemplateAsk.Slash },
                )).also { web = it } },
                modifier = Modifier.fillMaxWidth().weight(1f),
            )
            // The colour row unfolds above the toolbar instead of popping in.
            AnimatedVisibility(
                visible = palette,
                enter = expandVertically(motion.defaultEffectsSpec<IntSize>()) + fadeIn(motion.defaultEffectsSpec()),
                exit = shrinkVertically(motion.defaultEffectsSpec<IntSize>()) + fadeOut(motion.fastEffectsSpec()),
            ) {
                FlowRow(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Swatch(null, color == null) {
                        haptics.confirm()
                        palette = false
                        scope.launch { setMeta(clearColor = true) }
                    }
                    for (c in NOTE_COLORS) Swatch(c, color == c) {
                        haptics.confirm()
                        palette = false
                        scope.launch { setMeta(newColor = c) }
                    }
                }
            }
            // While typing, the bar above the keyboard is for formatting; the note's toolbar comes back with the keyboard down.
            if (keyboardUp) {
                FormatBar(onFormat = { js("window.sink.format(${JsonPrimitive(it)})") }, onImage = {
                    picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                }, onDone = ::hideKeyboard)
            } else {
                // The toolbar sits at the bottom, under the thumb.
                Row(
                    Modifier
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.surfaceContainer)
                        .padding(horizontal = 4.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = ::flushAndLeave) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") }
                    Text(
                        crumb,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        status,
                        style = MaterialTheme.typography.labelMedium,
                        color = if (status.startsWith("Offline") || status.startsWith("Can't")) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                    )
                    IconButton(onClick = {
                        haptics.toggle(!pinned)
                        scope.launch { setMeta(pin = !pinned) }
                    }) {
                        Icon(if (pinned) Icons.Filled.PushPin else Icons.Outlined.PushPin, if (pinned) "Unpin" else "Pin")
                    }
                    IconButton(onClick = { haptics.tick(); palette = !palette }) { Icon(Icons.Outlined.Palette, "Colour") }
                    Box {
                        IconButton(onClick = { haptics.tick(); menu = true }) { Icon(Icons.Outlined.MoreVert, "More") }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(
                                text = { Text("Add image") },
                                leadingIcon = { Icon(Icons.Outlined.AddPhotoAlternate, null) },
                                onClick = {
                                    menu = false
                                    picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("Insert template") },
                                leadingIcon = { Icon(Icons.Outlined.ContentCopy, null) },
                                onClick = {
                                    menu = false
                                    templating = TemplateAsk.Menu
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("Go to note") },
                                leadingIcon = { Icon(Icons.Outlined.Search, null) },
                                onClick = {
                                    menu = false
                                    onSwitch()
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("Move to folder") },
                                leadingIcon = { Icon(Icons.AutoMirrored.Outlined.DriveFileMove, null) },
                                onClick = {
                                    menu = false
                                    moving = true
                                },
                            )
                            if (ed.path != null && ed.path?.endsWith(".excalidraw.md", ignoreCase = true) != true) DropdownMenuItem(
                                text = { Text("Share link") },
                                leadingIcon = { Icon(Icons.Outlined.Share, null) },
                                onClick = {
                                    menu = false
                                    haptics.tick()
                                    // Saved first, so the link shows what's on screen.
                                    flush { sharing = true }
                                },
                            )
                            if (ed.path != null) DropdownMenuItem(
                                text = { Text("Version history") },
                                leadingIcon = { Icon(Icons.Outlined.History, null) },
                                onClick = {
                                    menu = false
                                    history = true
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("Rename") },
                                leadingIcon = { Icon(Icons.Outlined.DriveFileRenameOutline, null) },
                                onClick = {
                                    menu = false
                                    renaming = true
                                },
                            )
                            if (ed.path != null) {
                                val archived = ed.path?.startsWith("Archive/", ignoreCase = true) == true
                                DropdownMenuItem(
                                    text = { Text(if (archived) "Unarchive" else "Archive") },
                                    leadingIcon = { Icon(if (archived) Icons.Outlined.Unarchive else Icons.Outlined.Archive, null) },
                                    onClick = {
                                        menu = false
                                        haptics.confirm()
                                        archive()
                                    },
                                )
                            }
                            DropdownMenuItem(
                                text = { Text("Delete") },
                                leadingIcon = { Icon(Icons.Outlined.Delete, null) },
                                onClick = {
                                    menu = false
                                    haptics.reject()
                                    trash()
                                },
                            )
                        }
                    }
                }
            }
        }
        // Above the bottom toolbar.
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().imePadding().padding(bottom = 64.dp))
    }

    DisposableEffect(Unit) { onDispose { web?.destroy() } }

    templating?.let { ask ->
        // /template is waiting on an answer; anything but a template is null, so it stops waiting.
        fun answer(text: String?) {
            templating = null
            if (ask == TemplateAsk.Slash) js("window.sink.template(${JsonPrimitive(text)})")
            else if (text != null) js("window.sink.insert(${JsonPrimitive(text)})")
        }
        TemplatePickerSheet(
            templatesIn(vm.state.value.notes),
            onPick = { p ->
                templating = null
                scope.launch {
                    val title = ed.path?.substringAfterLast('/')?.removeSuffix(".md").orEmpty()
                    val (text, error) = vm.templateText(p, title, inline = true)
                    answer(text)
                    error?.let { snackbar.showSnackbar(it) }
                }
            },
            onDismiss = { answer(null) },
        )
    }

    /**
     * Saves, then moves the note to [dest] (a full path ending in .md). The editor keeps going on the moved file.
     * Mirrors web/src/notes.js; the server refuses to overwrite, so a taken name is a 409.
     */
    fun relocate(dest: String, taken: String, done: String) {
        scope.launch {
            saveJob?.cancel()
            save()
            val from = ed.path ?: return@launch snackbar.showSnackbar("Write something first").let { }
            if (dest == from) return@launch
            runCatching { api()!!.moveNote(from, dest) }
                .onSuccess {
                    store.forget(from)
                    vm.renameOpened(from, dest)
                    ed.path = dest
                    ed.folder = dest.substringBeforeLast('/', "")
                    crumb = ed.folder.ifEmpty { "Notes" }
                    vm.refresh()
                    snackbar.showSnackbar(done)
                }
                .onFailure {
                    snackbar.showSnackbar(
                        when {
                            it is ApiException && it.code == 409 -> taken
                            it is ApiException -> it.message ?: "Couldn't move"
                            else -> "You're offline. Moving needs the server."
                        },
                    )
                }
        }
    }

    if (moving) {
        val current = ed.path ?: ed.folder
        val here = ed.path?.substringBeforeLast('/', "") ?: ed.folder
        FolderPickerSheet(
            title = "Move to folder",
            folders = vm.state.value.folders,
            current = here,
            onPick = { parent ->
                moving = false
                val name = current.substringAfterLast('/')
                relocate(listOf(parent, name).filter { it.isNotEmpty() }.joinToString("/"), "A note with that name is already there", "Moved")
            },
            onNewFolder = { p ->
                val (made, error) = vm.createFolderAt(p)
                error?.let { snackbar.showSnackbar(it) }
                made
            },
            onDismiss = { moving = false },
        )
    }

    if (sharing) {
        val p = ed.path
        if (p == null) sharing = false
        else ShareDialog(api = ::api, path = p, title = p.substringAfterLast('/').removeSuffix(".md"), onDismiss = { sharing = false })
    }

    if (history) {
        val p = ed.path
        if (p == null) history = false
        else VersionHistorySheet(api = ::api, path = p, onRestore = ::restore, onDismiss = { history = false })
    }

    if (renaming) {
        val p = ed.path
        NameDialog(
            title = "Rename note",
            initial = p?.substringAfterLast('/')?.removeSuffix(".md").orEmpty(),
            confirm = "Rename",
            onConfirm = { name ->
                renaming = false
                if (p == null) return@NameDialog
                val parent = p.substringBeforeLast('/', "")
                relocate(listOf(parent, "$name.md").filter { it.isNotEmpty() }.joinToString("/"), "A note with that name already exists", "Renamed")
            },
            onDismiss = { renaming = false },
        )
    }
}

/**
 * The bar above the keyboard: headings, todos, lists and marks a tap away (the editor page does the edit, see
 * editor.js format), scrolling sideways, with the keyboard's own close at the end.
 */
@Composable
private fun FormatBar(onFormat: (String) -> Unit, onImage: () -> Unit, onDone: () -> Unit) {
    @Composable
    fun Label(text: String) = Text(text, style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold))
    val tools: List<Pair<String, @Composable () -> Unit>> = listOf(
        Pair("h1") { Label("H1") },
        Pair("h2") { Label("H2") },
        Pair("h3") { Label("H3") },
        Pair("task") { Icon(Icons.Outlined.CheckBox, "Todo") },
        Pair("bullet") { Icon(Icons.AutoMirrored.Outlined.FormatListBulleted, "Bulleted list") },
        Pair("numbered") { Icon(Icons.Outlined.FormatListNumbered, "Numbered list") },
        Pair("bold") { Icon(Icons.Outlined.FormatBold, "Bold") },
        Pair("italic") { Icon(Icons.Outlined.FormatItalic, "Italic") },
        Pair("strike") { Icon(Icons.Outlined.StrikethroughS, "Strikethrough") },
        Pair("link") { Icon(Icons.Outlined.Link, "Link to a note") },
        Pair("quote") { Icon(Icons.Outlined.FormatQuote, "Quote") },
        Pair("code") { Icon(Icons.Outlined.Code, "Code") },
        Pair("outdent") { Icon(Icons.AutoMirrored.Outlined.FormatIndentDecrease, "Outdent") },
        Pair("indent") { Icon(Icons.AutoMirrored.Outlined.FormatIndentIncrease, "Indent") },
        Pair("undo") { Icon(Icons.AutoMirrored.Outlined.Undo, "Undo") },
        Pair("redo") { Icon(Icons.AutoMirrored.Outlined.Redo, "Redo") },
    )
    Row(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainer).padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            for ((kind, content) in tools.take(3)) IconButton(onClick = { onFormat(kind) }) { content() }
            for ((kind, content) in tools.drop(3).take(3)) IconButton(onClick = { onFormat(kind) }) { content() }
            IconButton(onClick = onImage) { Icon(Icons.Outlined.AddPhotoAlternate, "Add image") }
            for ((kind, content) in tools.drop(6)) IconButton(onClick = { onFormat(kind) }) { content() }
        }
        IconButton(onClick = onDone) { Icon(Icons.Outlined.KeyboardHide, "Hide keyboard") }
    }
}

@Composable
private fun Swatch(name: String?, selected: Boolean, onClick: () -> Unit) {
    val ring = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant
    Box(
        Modifier
            .size(34.dp)
            .clip(CircleShape)
            .background(if (name == null) Color.Transparent else noteTint(name, MaterialTheme.colorScheme.surfaceContainerLow, 0.55f))
            .border(2.dp, ring, CircleShape)
            .clickable(onClick = onClick),
        Alignment.Center,
    ) {
        if (name == null) Icon(Icons.Outlined.FormatColorReset, "No colour", Modifier.size(18.dp))
    }
}

/** Name, type and bytes of a picked image. */
private fun readPicked(context: Context, uri: Uri): Triple<String, String, ByteArray> {
    val resolver = context.contentResolver
    val mime = resolver.getType(uri) ?: "image/jpeg"
    val ext = mime.substringAfter('/').replace("jpeg", "jpg")
    val bytes = resolver.openInputStream(uri)!!.use { it.readBytes() }
    return Triple("Photo ${System.currentTimeMillis() / 1000}.$ext", mime, bytes)
}

/**
 * The bundled editor page (copied from web/dist by Gradle), served from a fake https origin so it runs as a normal
 * page. `https://sink.attachment/<name>` images come from the server with our token, cached on disk.
 */
@SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
private fun editorWebView(context: Context, vm: NotesViewModel, bridge: Bridge): WebView {
    val assets = WebViewAssetLoader.Builder()
        .addPathHandler("/", WebViewAssetLoader.PathHandler { path ->
            runCatching {
                val mime = when {
                    path.endsWith(".js") -> "text/javascript"
                    path.endsWith(".css") -> "text/css"
                    path.endsWith(".html") -> "text/html"
                    else -> "application/octet-stream"
                }
                WebResourceResponse(mime, "utf-8", context.assets.open("web/$path"))
            }.getOrNull()
        })
        .build()
    val cache = File(context.cacheDir, "attachments").apply { mkdirs() }

    return WebView(context).apply {
        setBackgroundColor(AndroidColor.TRANSPARENT)
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        addJavascriptInterface(bridge, "SinkBridge")
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val url = request.url
                if (url.host == "sink.attachment") return attachment(url.path.orEmpty().trimStart('/'))
                if (url.host == "sink.server") return pluginFile(url.encodedPath.orEmpty() + (url.encodedQuery?.let { "?$it" } ?: ""))
                return assets.shouldInterceptRequest(url)
            }

            /** A plugin's script or styles (or one of its GET routes), from the server with our token. */
            private fun pluginFile(pathAndQuery: String): WebResourceResponse {
                val res = runCatching { kotlinx.coroutines.runBlocking { vm.api() }?.pluginFile(pathAndQuery) }.getOrNull()
                // Module scripts from this "other origin" need CORS, or the page won't run them.
                val headers = mapOf("Access-Control-Allow-Origin" to "*", "Cache-Control" to "no-cache")
                if (res == null) return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, ByteArrayInputStream(ByteArray(0)))
                val (code, type, bytes) = res
                return WebResourceResponse(type.substringBefore(';'), "utf-8", code, if (code in 200..299) "OK" else "Error", headers, ByteArrayInputStream(bytes))
            }

            private fun attachment(ref: String): WebResourceResponse {
                val id = MessageDigest.getInstance("SHA-1").digest(ref.toByteArray()).joinToString("") { "%02x".format(it) }
                val file = File(cache, id)
                val typeFile = File(cache, "$id.type")
                if (!file.isFile) {
                    val fetched = runCatching {
                        kotlinx.coroutines.runBlocking { vm.api() }?.attachmentBytes(ref)
                    }.getOrNull()
                    if (fetched != null) {
                        file.writeBytes(fetched.second)
                        typeFile.writeText(fetched.first)
                    }
                }
                if (!file.isFile) return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                val type = typeFile.takeIf { it.isFile }?.readText()?.substringBefore(';') ?: "application/octet-stream"
                return WebResourceResponse(type, null, file.inputStream())
            }

            // The page never navigates; links go through the bridge.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
        }
        loadUrl(EDITOR_URL)
    }
}

/** Boards are Excalidraw drawings; the phone hands them to the web app, which has the editor. */
@Composable
private fun BoardScreen(path: String, serverUrl: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val name = path.substringAfterLast('/').removeSuffix(".md").removeSuffix(".excalidraw")
    BackHandler(onBack = onBack)
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceContainerLowest).statusBarsPadding()) {
        ScreenTitle(name, sub = path.substringBeforeLast('/', "").ifEmpty { null }, onBack = onBack)
        Column(Modifier.fillMaxSize().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Text("Boards open in Sink on the web, which has the Excalidraw editor.", style = MaterialTheme.typography.bodyLarge)
            Spacer(Modifier.size(20.dp))
            FilledTonalButton(onClick = {
                val hash = path.split('/').joinToString("/") { Uri.encode(it) }
                val url = "$serverUrl/#/n/$hash"
                runCatching { CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(url)) }
                    .onFailure { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
            }) {
                Icon(Icons.Outlined.OpenInBrowser, null)
                Spacer(Modifier.width(8.dp))
                Text("Open board")
            }
        }
    }
}
