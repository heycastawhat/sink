package nz.joshp.sink.data

import kotlinx.serialization.Serializable
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The editor page's live-editing socket (web/src/live.js), opened here rather than in the page: it carries the app's
 * token, and reaches a server on the LAN over plain http, which the page (served over https) couldn't. Messages pass
 * through untouched. The callbacks come on OkHttp's thread.
 */
internal class LiveSocket(api: Api, path: String, listener: Listener) {
    interface Listener {
        fun opened()
        fun text(text: String)
        fun binary(bytes: ByteString)
        /** `status` is the HTTP status if the server refused the socket, else 0 (the connection dropped). */
        fun closed(status: Int)
    }

    private val done = AtomicBoolean(false)
    private val socket: WebSocket = client.newWebSocket(api.request(path).build(), object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = listener.opened()
        override fun onMessage(webSocket: WebSocket, text: String) = listener.text(text)
        override fun onMessage(webSocket: WebSocket, bytes: ByteString) = listener.binary(bytes)
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (done.compareAndSet(false, true)) listener.closed(0)
        }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (done.compareAndSet(false, true)) listener.closed(response?.code?.takeIf { it in 400..599 } ?: 0)
        }
    })

    fun send(text: String) = socket.send(text)
    fun send(bytes: ByteString) = socket.send(bytes)
    fun close() {
        done.set(true)
        socket.close(1000, null)
    }

    private companion object {
        // No read timeout: a note can sit open and quiet. Pings find a dead connection instead (and keep proxies from
        // closing an idle one).
        val client = Http.client.newBuilder().readTimeout(0, TimeUnit.SECONDS).pingInterval(30, TimeUnit.SECONDS).build()
    }
}

/** What the editor page says about live editing (see web/src/embed-editor.js, SinkBridge.live). */
@Serializable
internal data class LiveState(
    val status: String = "",
    val kind: String = "",
    val bound: Boolean = false,
    val connected: Boolean = false,
    val pending: Boolean = true,
    val unavailable: Boolean = false,
    val gone: Boolean = false,
    val canResume: Boolean = false,
    val hash: String? = null,
    val saved: String? = null,
)
