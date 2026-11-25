package nz.joshp.sink.ui

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import nz.joshp.sink.data.Change
import nz.joshp.sink.data.LiveEvent
import nz.joshp.sink.data.QueuedSave
import java.io.IOException

/** Catch up on stream readiness (changes aren't replayed) and refresh the lists once per burst. */
internal suspend fun listenForNotesUpdates(
    events: suspend () -> Flow<LiveEvent>?,
    completed: Flow<QueuedSave>,
    onChange: suspend (Change) -> Unit,
    refresh: suspend (Change?) -> Unit,
): Unit = coroutineScope {
    var refreshJob: Job? = null

    fun invalidate(change: Change? = null) {
        refreshJob?.cancel()
        refreshJob = launch {
            delay(400)
            refresh(change)
        }
    }

    launch(start = CoroutineStart.UNDISPATCHED) {
        completed.collect { invalidate() }
    }

    var wait = 2_000L
    while (true) {
        val stream = events()
        if (stream != null) {
            try {
                stream.collect { event ->
                    wait = 2_000L
                    val change = (event as? LiveEvent.Changed)?.change
                    if (change != null) onChange(change)
                    invalidate(change)
                }
                wait = 2_000L
            } catch (_: IOException) {
                // Back off until the next connection attempt.
            }
        }
        delay(wait)
        wait = (wait * 2).coerceAtMost(60_000L)
    }
}
