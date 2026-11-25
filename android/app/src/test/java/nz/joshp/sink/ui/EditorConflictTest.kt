package nz.joshp.sink.ui

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import nz.joshp.sink.data.Note
import nz.joshp.sink.data.NoteMeta
import nz.joshp.sink.data.NoteSaver
import nz.joshp.sink.data.QueuedSave
import nz.joshp.sink.data.SaveResult
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

    @Test fun `reopened subfolder note resolves the same queued edit as the closing editor`() = runBlocking {
        val path = "Folder/Scratch.md"
        val closing = editor().apply {
            this.path = path
            folder = "Folder"
            queued = pendingEdit()!!.copy(at = 1L)
        }
        val reopened = editor().apply {
            this.path = path
            queued = closing.queued
        }
        var creates = 0
        val createCopy: suspend () -> SaveResult = {
            creates++
            SaveResult.Conflict(original.copy(path = path), copy.copy(path = "Folder/${copy.path}"), closing.current)
        }

        NoteSaver.save(reopened.pendingEdit()!!, reopened.queued, createCopy)
        NoteSaver.save(closing.pendingEdit()!!, closing.queued, createCopy)

        assertEquals(1, creates)
    }

    @Test fun `Back retry and reopened editor create one conflict copy on reconnect`() = runBlocking {
        val closing = editor().apply { path = "Reconnect Scratch.md"; queued = null }
        val first = closing.pendingEdit()!!
        assertEquals(SaveResult.Offline, NoteSaver.save(first, null) { SaveResult.Offline })
        closing.queued = first
        val backRetry = closing.pendingEdit()!!
        val reopened = editor().apply { path = first.path; queued = first }
        assertEquals(SaveResult.Offline, NoteSaver.save(backRetry, closing.queued) { SaveResult.Offline })
        closing.queued = backRetry

        var creates = 0
        val createCopy: suspend () -> SaveResult = {
            creates++
            SaveResult.Conflict(original.copy(path = first.path!!), copy.copy(path = "Copy $creates.md"), first.text)
        }
        val completed = async(start = CoroutineStart.UNDISPATCHED) {
            withTimeout(5_000) {
                NoteSaver.completed.filterIsInstance<QueuedSave.Conflict>().first { it.edit.key == first.key }
            }
        }
        val fromBack = NoteSaver.save(closing.pendingEdit()!!, closing.queued, createCopy)
        val fromReopen = NoteSaver.save(reopened.pendingEdit()!!, reopened.queued, createCopy)

        assertEquals(1, creates)
        assertEquals(fromBack, fromReopen)
        val outcome = completed.await()
        assertTrue(reopened.matchesConflict(outcome))
        reopened.adoptConflict(outcome.result())
        assertEquals(original.hash, reopened.hash)
        assertNull(reopened.pendingEdit())
    }
}
