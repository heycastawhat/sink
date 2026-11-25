package nz.joshp.sink.ui

import nz.joshp.sink.data.Note
import nz.joshp.sink.data.PendingEdit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EditorLoadTest {
    private val original = "---\ncolor: green\n---\n# Phone note\n"
    private val cachedNote = Note("Phone note.md", "Phone note", "h1", original)
    private val freshNote = Note("Phone note.md", "Phone note", "h2", original + "From desktop\n")

    @Test
    fun metadataChangedBeforePageReadyIsUsedWhenThePageLoads() {
        for (current in listOf(
            "---\ncolor: green\npinned: true\n---\n# Phone note\n",
            "---\ncolor: blue\n---\n# Phone note\n",
        )) {
            assertNull(editorLoadText(false, original, current))
            assertEquals(current, editorLoadText(true, original, current))
        }
    }

    @Test
    fun latestNativePendingEditsAreNotReplacedByTheInitialPayload() {
        val pending = original + "Unsynced edit\n"
        assertEquals(pending, editorLoadText(true, original, pending))
    }

    @Test
    fun currentEmptyTextIsNotReplacedByTheInitialPayload() {
        assertEquals("", editorLoadText(true, original, ""))
        assertEquals("", editorLoadText(true, "", ""))
    }

    @Test
    fun bothThePageAndNativeNoteMustBeReady() {
        assertNull(editorLoadText(false, original, original))
        assertNull(editorLoadText(true, null, original))
        assertEquals(original, editorLoadText(true, original, original))
    }

    @Test
    fun cachedNoteShowsImmediatelyBeforeServerResponds() {
        val ed = Editing("Phone note.md", "draft", "")

        val loaded = loadCachedNote(ed, cachedNote, pending = null)

        assertEquals(original, loaded)
        assertTrue(ed.loaded)
        assertFalse(ed.liveMode)
        assertEquals("h1", ed.hash)
        assertEquals(original, ed.saved)
        assertEquals(original, ed.current)
        assertEquals(original, editorLoadText(true, loaded, ed.current))
    }

    @Test
    fun pendingEditShowsImmediatelyOverCachedNoteWithoutLiveMode() {
        val ed = Editing("Phone note.md", "draft", "")
        val pending = PendingEdit("Phone note.md", "Phone note.md", "", "h0", original + "Queued\n", at = 1)

        val loaded = loadCachedNote(ed, cachedNote, pending)

        assertEquals(pending.text, loaded)
        assertTrue(ed.loaded)
        assertFalse(ed.liveMode)
        assertEquals("h0", ed.hash)
        assertEquals(original, ed.saved)
        assertEquals(pending, ed.queued)
        assertEquals(pending.text, editorLoadText(true, loaded, ed.current))
    }

    @Test
    fun freshNoteAfterCachedLoadUpdatesUntouchedEditorAndStartsLive() {
        val ed = Editing("Phone note.md", "draft", "")
        loadCachedNote(ed, cachedNote, pending = null)

        val outcome = applyFreshNote(ed, freshNote, pending = null, board = false, saving = false, pendingNow = false, statusText = "Edited now")

        assertTrue(outcome.applyMeta)
        assertEquals(freshNote.content, outcome.replaceEditorText)
        assertTrue(outcome.startLive)
        assertFalse(outcome.retireLive)
        assertFalse(outcome.scheduleSave)
        assertEquals("Edited now", outcome.status)
        assertTrue(ed.liveMode)
        assertEquals("h2", ed.hash)
        assertEquals(freshNote.content, ed.saved)
        assertEquals(freshNote.content, ed.current)
    }

    @Test
    fun matchingFreshNoteStartsLiveWithoutReplacingEditorText() {
        val ed = Editing("Phone note.md", "draft", "")
        loadCachedNote(ed, cachedNote, pending = null)

        val outcome = applyFreshNote(ed, cachedNote, pending = null, board = false, saving = false, pendingNow = false, statusText = "Edited now")

        assertTrue(outcome.applyMeta)
        assertNull(outcome.replaceEditorText)
        assertTrue(outcome.startLive)
        assertTrue(ed.liveMode)
    }

    @Test
    fun freshNoteDoesNotOverwriteEditsMadeWhileCachedCopyWasOpen() {
        val ed = Editing("Phone note.md", "draft", "")
        loadCachedNote(ed, cachedNote, pending = null)
        ed.current = original + "Typed offline\n"

        val outcome = applyFreshNote(ed, freshNote, pending = null, board = false, saving = false, pendingNow = false, statusText = "Edited now")

        assertFalse(outcome.applyMeta)
        assertNull(outcome.replaceEditorText)
        assertFalse(outcome.startLive)
        assertTrue(outcome.retireLive)
        assertFalse(ed.liveMode)
        assertEquals("h1", ed.hash)
        assertEquals(original + "Typed offline\n", ed.current)
    }

    @Test
    fun uncachedNoteLoadsFromServerAndStartsLiveForTextNotesOnly() {
        val textEd = Editing("Phone note.md", "draft", "")
        assertNull(loadCachedNote(textEd, cached = null, pending = null))
        val textOutcome = applyFreshNote(textEd, freshNote, pending = null, board = false, saving = false, pendingNow = false, statusText = "Edited now")
        assertTrue(textEd.loaded)
        assertTrue(textEd.liveMode)
        assertFalse(textOutcome.startLive)
        assertEquals(freshNote.content, textEd.current)

        val boardEd = Editing("Sketch.excalidraw.md", "draft", "")
        val boardNote = Note("Sketch.excalidraw.md", "Sketch", "hb", "board")
        loadCachedNote(boardEd, boardNote, pending = null)
        val boardOutcome = applyFreshNote(boardEd, boardNote, pending = null, board = true, saving = false, pendingNow = false, statusText = "Edited now")
        assertFalse(boardEd.liveMode)
        assertFalse(boardOutcome.startLive)
    }

    @Test
    fun missingNoteKeepsUnsavedEditsInsteadOfClosing() {
        val clean = Editing("Phone note.md", "draft", "")
        loadCachedNote(clean, cachedNote, pending = null)
        assertFalse(shouldKeepOnMissingNote(clean, pending = null, saving = false, pendingNow = false))

        val edited = Editing("Phone note.md", "draft", "")
        loadCachedNote(edited, cachedNote, pending = null)
        edited.current = original + "Typed before 404\n"
        assertTrue(shouldKeepOnMissingNote(edited, pending = null, saving = false, pendingNow = false))
    }
}
