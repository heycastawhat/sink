package nz.joshp.sink.data

import okio.ByteString.Companion.encodeUtf8
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

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

    @Test fun `a failed live cache write keeps the previous revision readable`() {
        val store = NoteStore(files.root)
        val original = Note("Scratch.md", hash = "old-hash", content = "Before")
        store.saveNote(original)
        val temporaryName = original.path.encodeUtf8().sha1().hex() + ".tmp"
        val temporaryFile = File(files.root, "notes/content/$temporaryName")
        assertTrue(temporaryFile.mkdir())

        val text = "Saved online"
        store.saveLiveRevision(original.path, text.encodeUtf8().sha256().hex(), text)

        assertEquals(original, NoteStore(files.root).note(original.path))
    }
}
