package nz.joshp.sink.data

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicInteger

class LiveTest {
    @Test fun `a new subscription signals catch-up without waiting for a change`() = runBlocking {
        val connections = AtomicInteger()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/events") { exchange ->
            exchange.responseHeaders.set("Content-Type", "text/event-stream")
            exchange.sendResponseHeaders(200, 0)
            val change = if (connections.getAndIncrement() == 0) {
                "event: change\ndata: {\"type\":\"note.updated\",\"path\":\"Scratch.md\"}\n\n"
            } else ""
            // Leave the stream open and silent, like a server between heartbeats.
            exchange.responseBody.write(("event: ready\ndata: {}\n\n" + change).toByteArray())
            exchange.responseBody.flush()
        }
        server.start()

        try {
            val api = Api(Session("http://127.0.0.1:${server.address.port}", "test-token"))
            val events = Channel<LiveEvent>(Channel.UNLIMITED)
            val foreground = launch { api.liveEvents().collect { events.send(it) } }
            withTimeout(5_000) {
                assertEquals(LiveEvent.Ready, events.receive())
                assertEquals(LiveEvent.Changed(Change("note.updated", "Scratch.md")), events.receive())
                // Backgrounding must not block the next subscription on the old read timeout.
                foreground.cancelAndJoin()
            }

            val resumed = launch { api.liveEvents().collect { events.send(it) } }
            withTimeout(5_000) {
                assertEquals(LiveEvent.Ready, events.receive())
                resumed.cancelAndJoin()
            }
            assertEquals(2, connections.get())
        } finally {
            server.stop(0)
        }
    }
}
