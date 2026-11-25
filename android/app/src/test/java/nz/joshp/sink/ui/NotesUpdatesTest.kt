package nz.joshp.sink.ui

import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import nz.joshp.sink.data.LiveEvent
import nz.joshp.sink.data.NoteMeta
import nz.joshp.sink.data.PendingEdit
import nz.joshp.sink.data.QueuedSave
import org.junit.Assert.assertNull
import org.junit.Test

class NotesUpdatesTest {
    @Test fun `a synced conflict refreshes the grid while the event stream stays silent`() = runBlocking {
        val completed = MutableSharedFlow<QueuedSave>()
        val refreshes = Channel<Unit>(Channel.UNLIMITED)
        val listener = launch {
            listenForNotesUpdates(
                events = { flow { emit(LiveEvent.Ready); awaitCancellation() } },
                completed = completed,
                onChange = { error("The stream should stay silent after Ready") },
                refresh = { assertNull(it); refreshes.send(Unit) },
            )
        }

        try {
            withTimeout(5_000) {
                refreshes.receive()
                val edit = PendingEdit("Scratch.md", "Scratch.md", baseHash = "old", text = "Offline edit")
                val copy = NoteMeta("Scratch (conflict).md", "Scratch (conflict)")
                completed.emit(QueuedSave.Conflict(edit, server = null, copy = copy))
                refreshes.receive()
            }
        } finally {
            listener.cancelAndJoin()
        }
    }
}
