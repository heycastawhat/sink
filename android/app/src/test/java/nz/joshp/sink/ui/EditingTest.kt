package nz.joshp.sink.ui

import nz.joshp.sink.data.Note
import nz.joshp.sink.data.PendingEdit
import nz.joshp.sink.data.QueuedSave
import nz.joshp.sink.data.SaveResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EditingTest {
    private val path = "Scratch.md"
    private val edit = PendingEdit(path, path, baseHash = "before", text = "Offline edit")
    private val ack = QueuedSave.Saved(edit, path, "after-sync")
    private val remote = Note(path, "Scratch", "remote", "PWA edit")

    private fun offlineEditor(currentText: String) = Editing(path, "draft", "").apply {
        loaded = true
        hash = edit.baseHash
        saved = "Original text"
        current = currentText
        queued = edit
    }

    @Test
    fun successfulWorkerSaveUnblocksTheNextRemoteEdit() {
        val editor = offlineEditor(edit.text)
        assertTrue(editor.dirty)
        assertFalse(editor.acceptRemote(remote, edit.baseHash))

        assertTrue(editor.acknowledge(ack))
        assertEquals("after-sync", editor.hash)
        assertEquals(edit.text, editor.saved)
        assertEquals(edit.text, editor.current)
        assertNull(editor.queued)
        assertFalse(editor.dirty)

        assertTrue(editor.acceptRemote(remote, ack.hash))
        assertEquals(remote.content, editor.current)
        assertEquals(remote.hash, editor.hash)
        assertFalse(editor.dirty)
    }

    @Test
    fun workerSaveAdvancesTheBaseWithoutClobberingNewerTyping() {
        val editor = offlineEditor("Offline edit plus new typing")

        assertTrue(editor.acknowledge(ack))
        assertEquals(ack.hash, editor.hash)
        assertEquals(edit.text, editor.saved)
        assertTrue(editor.dirty)
        assertFalse(editor.acceptRemote(remote, ack.hash))
        assertEquals("Offline edit plus new typing", editor.current)
    }

    @Test
    fun foregroundSaveWaitingBehindWorkerRebuildsItsEditWithTheAcknowledgedHash() {
        val editor = offlineEditor("Offline edit plus new typing")
        val waiting = editor.pendingEdit()!!
        assertEquals(edit.baseHash, waiting.baseHash)

        val result = ack.beforeWrite(waiting, editor.queued) as SaveResult.Acknowledged
        assertTrue(editor.acknowledge(result.outcome))

        val next = editor.pendingEdit()!!
        assertEquals(ack.hash, next.baseHash)
        assertEquals(waiting.text, next.text)
        assertNull(ack.beforeWrite(next, editor.queued))
    }

    @Test
    fun workerSaveOnlyAcknowledgesTheExactQueuedEditOnTheSameBaseAndPath() {
        val waiting = offlineEditor("New typing").pendingEdit()!!
        assertNull(ack.beforeWrite(waiting, edit.copy(at = edit.at + 1)))
        assertNull(ack.beforeWrite(waiting.copy(baseHash = remote.hash), edit))
        assertNull(ack.beforeWrite(waiting.copy(path = "Other.md"), edit))
    }
}
