package nz.joshp.sink.ui

import nz.joshp.sink.data.LiveHandoff
import nz.joshp.sink.data.Note
import nz.joshp.sink.data.PendingEdit
import nz.joshp.sink.data.QueuedSave
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
    fun retiringLiveAttachesTheSnapshotOnlyToTheSamePathAndBaseHash() {
        val snapshot = LiveHandoff("room", "dXBkYXRl")
        val editor = offlineEditor(edit.text)
        editor.retireLive(path, checkNotNull(edit.baseHash), snapshot)
        val pending = checkNotNull(editor.pendingEdit())
        assertEquals(snapshot, pending.live)

        val reopened = offlineEditor(edit.text + " again").apply { queued = pending }
        assertEquals(snapshot, reopened.pendingEdit()?.live)
        reopened.hash = "new revision"
        assertNull(reopened.pendingEdit()?.live)

        editor.path = "Other.md"
        assertNull(editor.pendingEdit()?.live)
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
}
