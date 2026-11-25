package nz.joshp.sink.data

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList

class NoteSaveTest {
    private val plainBody = buildJsonObject {
        put("content", "Edited text")
        put("base_hash", "last-seen")
        put("keep_version", true)
    }
    private val handoff = LiveHandoff("04a42d2e-ef81-4a91-a68e-55c63dec797a", "AA==")

    @Test fun `a 413 retries without the live handoff but keeps the hash and text`() = runBlocking {
        withServer(413, 200) { api, requests ->
            val saved = api.saveNote("Scratch.md", "Edited text", "last-seen", keepVersion = true, live = handoff)

            assertEquals("saved", saved.hash)
            assertEquals(listOf(liveBody(), plainBody), requests)
        }
    }

    @Test fun `a conflict is not retried without the live handoff`() = runBlocking {
        withServer(409) { api, requests ->
            val failure = runCatching {
                api.saveNote("Scratch.md", "Edited text", "last-seen", keepVersion = true, live = handoff)
            }.exceptionOrNull()

            assertEquals(409, (failure as ApiException).code)
            assertEquals(listOf(liveBody()), requests)
        }
    }

    @Test fun `a handoff above the server field limit is omitted`() = runBlocking {
        withServer(200) { api, requests ->
            val large = handoff.copy(update = "AAAA".repeat(4 * 1024 * 1024 + 1))
            val saved = api.saveNote("Scratch.md", "Edited text", "last-seen", keepVersion = true, live = large)

            assertEquals("saved", saved.hash)
            assertEquals(listOf(plainBody), requests)
        }
    }

    private fun liveBody() = JsonObject(plainBody + ("live" to json.encodeToJsonElement(LiveHandoff.serializer(), handoff)))

    private suspend fun withServer(vararg statuses: Int, check: suspend (Api, List<JsonObject>) -> Unit) {
        val requests = CopyOnWriteArrayList<JsonObject>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/notes/file") { exchange ->
            val body = exchange.requestBody.bufferedReader().use { it.readText() }
            requests.add(json.decodeFromString(body))
            val status = statuses.getOrElse(requests.size - 1) { 500 }
            val reply = """{"path":"Scratch.md","title":"Scratch","hash":"saved"}""".toByteArray()
            exchange.sendResponseHeaders(status, reply.size.toLong())
            exchange.responseBody.use { it.write(reply) }
        }
        server.start()

        try {
            check(Api(Session("http://127.0.0.1:${server.address.port}", "test-token")), requests)
        } finally {
            server.stop(0)
        }
    }
}
