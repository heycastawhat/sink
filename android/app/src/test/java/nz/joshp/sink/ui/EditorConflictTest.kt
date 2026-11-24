package nz.joshp.sink.ui

import nz.joshp.sink.data.Note
import nz.joshp.sink.data.NoteMeta
import nz.joshp.sink.data.QueuedSave
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EditorConflictTest {
    private val original = Note("Scratch.md", hash = "pwa-hash", content = "PWA edit")
    private val copy = NoteMeta("Scratch (conflict).md", "Scratch (conflict)", hash = "android-hash")

    private fun editor() = Editing(original.path, "draft", "").apply {
        loaded = true
        hash = "old-hash"
        saved = "original text"
        current = "Android edit"
        queued = pendingEdit()!!.copy(at = 2L)
    }

    @Test fun `a worker conflict followed by two unchanged flushes creates only the worker copy`() {
        val editor = editor()
        val outcome = QueuedSave.Conflict(editor.queued!!, original, copy)
        assertTrue(editor.matchesConflict(outcome))
        editor.adoptConflict(outcome.result())

        repeat(2) {
            assertNull(editor.pendingEdit())
        }

        assertEquals(original.hash, editor.hash)
        assertEquals(original.content, editor.current)
        assertNull(editor.queued)
    }

    @Test fun `text typed after the worker edit is saved against the conflict copy`() {
        val editor = editor()
        val outcome = QueuedSave.Conflict(editor.queued!!, original, copy)
        editor.current = "Android edit and then more"

        assertTrue(editor.matchesConflict(outcome))
        editor.adoptConflict(outcome.result())

        val next = editor.pendingEdit()!!
        assertEquals(copy.path, next.path)
        assertEquals(copy.hash, next.baseHash)
        assertEquals("Android edit and then more", next.text)
    }

    @Test fun `an old conflict does not acknowledge a new queued edit with identical text and base`() {
        val editor = editor()
        val earlier = editor.queued!!.copy(at = 1L)
        val staleOutcome = QueuedSave.Conflict(earlier, original, copy)

        assertFalse(editor.matchesConflict(staleOutcome))
        assertEquals(original.path, editor.pendingEdit()?.path)
    }

    @Test fun `a foreground edit behind a conflicted worker gets the existing conflict`() {
        val editor = editor()
        val outcome = QueuedSave.Conflict(editor.queued!!, original, copy)
        editor.current = "Android edit and then more"

        assertEquals(outcome.result(), outcome.beforeWrite(editor.pendingEdit()!!, editor.queued))
    }
}
