package nz.joshp.sink.data

import okio.ByteString.Companion.encodeUtf8
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class NoteStoreTest {
    @get:Rule val files = TemporaryFolder()

    @Test fun `offline reopen uses the cached live revision and keeps note metadata`() {
        val store = NoteStore(files.root)
        val original = Note("Scratch.md", "Scratch", "old-hash", "Before", mtime = 42, pinned = true, color = "blue")
        store.saveNote(original)
        val text = "Edited online"
        val hash = text.encodeUtf8().sha256().hex()

        store.saveLiveRevision(original.path, hash, original.content)
        assertEquals(original, NoteStore(files.root).note(original.path))

        store.saveLiveRevision(original.path, hash, text)
        assertEquals(original.copy(hash = hash, content = text), NoteStore(files.root).note(original.path))
    }
}
