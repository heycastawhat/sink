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

internal fun shouldKeepOnMissingNote(
    ed: Editing,
    pending: PendingEdit?,
    saving: Boolean,
    pendingNow: Boolean,
): Boolean = ed.dirty || ed.queued != null || pending != null || saving || pendingNow

internal data class FreshLoadOutcome(
    val saveCache: Boolean = false,
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
    initialPath: String? = ed.path,
    initialHash: String? = ed.hash,
    initialSaved: String = ed.saved,
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
            saveCache = true,
            applyMeta = true,
            scheduleSave = start != ed.saved,
            status = statusText,
        )
    }
    val advanced = ed.path != initialPath || ed.hash != initialHash || ed.saved != initialSaved
    if (pending != null) {
        if (saving || advanced || ed.queued != pending) return FreshLoadOutcome()
        ed.saved = fresh.content
        return FreshLoadOutcome(
            saveCache = true,
            applyMeta = true,
            scheduleSave = ed.current != ed.saved,
            status = statusText,
        )
    }
    if (advanced || ed.dirty || saving || pendingNow || ed.queued != null) {
        return FreshLoadOutcome(retireLive = true)
    }
    val changed = fresh.content != ed.current
    ed.hash = fresh.hash
    ed.saved = fresh.content
    ed.current = fresh.content
    ed.liveMode = !board
    return FreshLoadOutcome(
        saveCache = true,
        applyMeta = true,
        replaceEditorText = if (changed) fresh.content else null,
        startLive = !board,
        status = statusText,
    )
}
