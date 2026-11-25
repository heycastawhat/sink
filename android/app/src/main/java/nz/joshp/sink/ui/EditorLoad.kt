package nz.joshp.sink.ui

import nz.joshp.sink.data.Note
import nz.joshp.sink.data.PendingEdit

internal fun editorLoadText(pageReady: Boolean, loadedNote: String?, current: String): String? =
    if (pageReady && loadedNote != null) current else null

/**
 * Loads the phone's cached copy (or queued offline edit) into [ed] immediately so a slow or silently dropped
 * server request does not leave the editor blank while waiting to time out.
 */
internal fun loadCachedNote(ed: Editing, cached: Note?, pending: PendingEdit?): String? {
    if (cached == null && pending == null) return null
    cached?.let {
        ed.hash = it.hash
        ed.saved = it.content
    }
    val start = pending?.let {
        ed.hash = it.baseHash
        ed.queued = it
        it.text
    } ?: ed.saved
    ed.current = start
    ed.loaded = true
    ed.liveMode = false
    return start
}

internal data class FreshLoadOutcome(
    val applyMeta: Boolean = false,
    val replaceEditorText: String? = null,
    val startLive: Boolean = false,
    val retireLive: Boolean = false,
    val scheduleSave: Boolean = false,
    val status: String? = null,
)

/**
 * Reconciles the server's [fresh] copy with [ed], which may already be showing a cached copy or pending edit.
 */
internal fun applyFreshNote(
    ed: Editing,
    fresh: Note,
    pending: PendingEdit?,
    board: Boolean,
    saving: Boolean,
    pendingNow: Boolean,
    statusText: String,
): FreshLoadOutcome {
    if (!ed.loaded) {
        ed.hash = fresh.hash
        ed.saved = fresh.content
        val start = pending?.let {
            ed.hash = it.baseHash
            ed.queued = it
            it.text
        } ?: fresh.content
        ed.current = start
        ed.loaded = true
        ed.liveMode = !board && pending == null
        return FreshLoadOutcome(
            applyMeta = true,
            scheduleSave = start != ed.saved,
            status = statusText,
        )
    }
    if (pending != null) {
        if (saving || ed.queued != pending) return FreshLoadOutcome()
        ed.saved = fresh.content
        return FreshLoadOutcome(
            applyMeta = true,
            scheduleSave = ed.current != ed.saved,
            status = statusText,
        )
    }
    if (ed.dirty || saving || pendingNow || ed.queued != null) {
        return FreshLoadOutcome(retireLive = true)
    }
    val changed = fresh.content != ed.current
    ed.hash = fresh.hash
    ed.saved = fresh.content
    ed.current = fresh.content
    ed.liveMode = !board
    return FreshLoadOutcome(
        applyMeta = true,
        replaceEditorText = if (changed) fresh.content else null,
        startLive = !board,
        status = statusText,
    )
}
