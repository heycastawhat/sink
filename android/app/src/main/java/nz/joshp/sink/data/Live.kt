package nz.joshp.sink.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.isActive
import kotlinx.serialization.Serializable
import java.io.IOException
import java.util.concurrent.TimeUnit

/** A change on the server: a note created, updated, deleted or moved (from [from]), or a todo ticked. */
@Serializable
data class Change(val type: String, val path: String, val from: String? = null)

/**
 * The server's live change stream (GET /api/events, Server-Sent Events), until it closes or fails. The server sends a
 * keep-alive every 25s, so a read that waits 90s means the connection is gone.
 */
fun Api.changes(): Flow<Change> = callbackFlow {
    val client = Http.client.newBuilder().readTimeout(90, TimeUnit.SECONDS).build()
    val call = client.newCall(request("/api/events").header("Accept", "text/event-stream").build())
    try {
        call.execute().use { res ->
            if (!res.isSuccessful) throw ApiException(res.code, "events: HTTP ${res.code}")
            val source = res.body.source()
            var event = ""
            while (isActive) {
                val line = source.readUtf8Line() ?: break
                when {
                    line.startsWith("event:") -> event = line.removePrefix("event:").trim()
                    line.startsWith("data:") && event == "change" ->
                        runCatching { json.decodeFromString<Change>(line.removePrefix("data:").trim()) }.getOrNull()?.let { trySend(it) }
                    line.isEmpty() -> event = ""
                }
            }
        }
        close()
    } catch (e: IOException) {
        close(e)
    }
    awaitClose { call.cancel() }
}.flowOn(Dispatchers.IO)
