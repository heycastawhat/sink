package nz.joshp.sink.ui

import nz.joshp.sink.data.Note
import nz.joshp.sink.data.PendingEdit
import nz.joshp.sink.data.QueuedSave
import nz.joshp.sink.data.SaveResult

/** What the note screen tracks between saves. Not Compose state: the WebView owns the text. */
internal class Editing(var path: String?, val draftKey: String, var folder: String) {
    var hash: String? = null
    /** Text as last confirmed on the server (or loaded). */
    var saved: String = ""
    /** Latest text from the editor. */
    var current: String = ""
    var queued: PendingEdit? = null
    var loaded = false
    /** The page is editing live (web/src/live.js) and syncs every edit itself: nothing here saves it. */
    var liveMode = false
    val key get() = path ?: draftKey
    val dirty get() = loaded && current != saved
    /** Flushes still reading the page, and whether the screen has gone: the page is destroyed after the last. */
    var flushing = 0
    var closed = false

    fun pendingEdit(): PendingEdit? {
        if (!dirty || (path == null && current.isBlank())) return null
        val edit = PendingEdit(key, path, folder, hash, current)
        return queued?.takeIf { it == edit.copy(at = it.at) } ?: edit.copy(at = System.currentTimeMillis())
    }

    fun matchesConflict(outcome: QueuedSave.Conflict): Boolean =
        loaded && outcome.matches(queued, key, hash)

    /** Follow the copy if it has newer local edits; otherwise continue on the original. */
    fun adoptConflict(result: SaveResult.Conflict) {
        queued = null
        val theirs = result.theirs
        val copy = result.copy
        if (copy != null && (theirs == null || current != result.savedText)) {
            path = copy.path
            hash = copy.hash
            saved = result.savedText
        } else if (theirs != null) {
            hash = theirs.hash
            saved = theirs.content
            if (copy != null) current = theirs.content
        }
    }

    fun acknowledge(saved: QueuedSave.Saved): Boolean {
        val edit = saved.edit
        if (!loaded || path != saved.path || hash != edit.baseHash || queued != edit) return false
        hash = saved.hash
        this.saved = edit.text
        queued = null
        return true
    }

    fun acceptRemote(note: Note, requestedHash: String?): Boolean {
        if (!loaded || dirty || path != note.path || hash != requestedHash || note.hash == hash) return false
        hash = note.hash
        saved = note.content
        current = note.content
        return true
    }
}
