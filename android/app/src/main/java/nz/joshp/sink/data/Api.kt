package nz.joshp.sink.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

@Serializable
data class Action(
    val id: String,
    val type: String,
    val label: String,
    val payload: JsonObject = JsonObject(emptyMap()),
    val state: String,
    @SerialName("due_at") val dueAt: Long? = null,
)

@Serializable
data class Capture(
    val id: String,
    @SerialName("created_at") val createdAt: Long,
    val source: String,
    val width: Int,
    val height: Int,
    @SerialName("note_text") val note: String? = null,
    @SerialName("ocr_text") val ocrText: String? = null,
    val status: String,
    val error: String? = null,
    val kind: String? = null,
    val title: String? = null,
    val summary: String? = null,
    val tags: List<String> = emptyList(),
    val entities: Map<String, List<String>> = emptyMap(),
    val model: String? = null,
    val pinned: Boolean = false,
    @SerialName("archived_at") val archivedAt: Long? = null,
    @SerialName("deleted_at") val deletedAt: Long? = null,
    @SerialName("source_url") val sourceUrl: String? = null,
    @SerialName("image_url") val imageUrl: String,
    @SerialName("thumb_url") val thumbUrl: String,
    val actions: List<Action>? = null,
    /** Collection ids; only on the detail fetch. */
    val collections: List<String>? = null,
) {
    val busy get() = status == "pending" || status == "processing"
}

@Serializable
data class SinkCollection(
    val id: String,
    val name: String,
    val count: Int = 0,
    @SerialName("cover_url") val coverUrl: String? = null,
)

@Serializable
private data class CollectionList(val collections: List<SinkCollection>)

@Serializable
data class Reminder(
    val id: String,
    @SerialName("capture_id") val captureId: String,
    val type: String,
    val label: String,
    val payload: JsonObject = JsonObject(emptyMap()),
    val state: String,
    @SerialName("due_at") val dueAt: Long,
    @SerialName("capture_title") val captureTitle: String? = null,
) {
    val text get() = payload.str("text") ?: label
}

@Serializable
private data class ReminderList(val reminders: List<Reminder>)

@Serializable
private data class Digest(val unreviewed: List<Capture>)

@Serializable
data class Page(val items: List<Capture>, @SerialName("next_cursor") val nextCursor: String? = null)

@Serializable
private data class LoginResponse(val token: String? = null, val error: String? = null)

@Serializable
private data class ErrorResponse(val error: String? = null)

class ApiException(val code: Int, message: String) : IOException(message)

val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

object Http {
    val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .build()
}

/** Normalises what people type: adds https:// (or http:// for LAN IPs), strips trailing slash. */
fun normalizeServerUrl(input: String): String {
    var url = input.trim().trimEnd('/')
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
        val lan = Regex("""^(localhost|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[\w-]+\.local)""").containsMatchIn(url)
        url = (if (lan) "http://" else "https://") + url
    }
    return url
}

class Api(private val session: Session) {
    private val base = session.serverUrl

    fun absolute(path: String) = base + path

    private fun request(path: String) = Request.Builder()
        .url(base + path)
        .header("Authorization", "Bearer ${session.token}")

    private suspend fun <T> call(req: Request, parse: (String) -> T): T = withContext(Dispatchers.IO) {
        Http.client.newCall(req).execute().use { res ->
            val body = res.body.string()
            if (!res.isSuccessful) {
                val msg = runCatching { json.decodeFromString<ErrorResponse>(body).error }.getOrNull()
                throw ApiException(res.code, msg ?: "HTTP ${res.code}")
            }
            parse(body)
        }
    }

    private fun jsonBody(obj: JsonObject) = obj.toString().toRequestBody("application/json".toMediaType())

    suspend fun list(q: String?, kind: String?, collection: String?, view: String, cursor: String?): Page {
        val url = (base + "/api/captures").toHttpUrl().newBuilder().apply {
            if (!q.isNullOrBlank()) addQueryParameter("q", q)
            if (kind != null) addQueryParameter("kind", kind)
            if (collection != null) addQueryParameter("collection", collection)
            addQueryParameter("view", view)
            if (cursor != null) addQueryParameter("cursor", cursor)
        }.build()
        val req = Request.Builder().url(url).header("Authorization", "Bearer ${session.token}").build()
        return call(req) { json.decodeFromString<Page>(it) }
    }

    suspend fun get(id: String): Capture = call(request("/api/captures/$id").build()) { json.decodeFromString(it) }

    suspend fun patch(id: String, body: JsonObject): Capture =
        call(request("/api/captures/$id").patch(jsonBody(body)).build()) { json.decodeFromString(it) }

    suspend fun reprocess(id: String): Capture =
        call(request("/api/captures/$id/reprocess").post(ByteArray(0).toRequestBody()).build()) { json.decodeFromString(it) }

    suspend fun purge(id: String) = call(request("/api/captures/$id").delete().build()) { }

    suspend fun setAction(id: String, state: String? = null, dueAt: Long? = null) =
        call(
            request("/api/actions/$id").patch(
                jsonBody(buildJsonObject {
                    state?.let { put("state", it) }
                    dueAt?.let { put("due_at", it) }
                }),
            ).build(),
        ) { }

    /** Last week's captures not looked at again yet. */
    suspend fun digest(): List<Capture> = call(request("/api/digest").build()) { json.decodeFromString<Digest>(it).unreviewed }

    suspend fun collections(): List<SinkCollection> =
        call(request("/api/collections").build()) { json.decodeFromString<CollectionList>(it).collections }

    suspend fun createCollection(name: String): SinkCollection =
        call(request("/api/collections").post(jsonBody(buildJsonObject { put("name", name) })).build()) { json.decodeFromString(it) }

    suspend fun renameCollection(id: String, name: String): SinkCollection =
        call(request("/api/collections/$id").patch(jsonBody(buildJsonObject { put("name", name) })).build()) { json.decodeFromString(it) }

    suspend fun deleteCollection(id: String) = call(request("/api/collections/$id").delete().build()) { }

    suspend fun reminders(): List<Reminder> =
        call(request("/api/reminders").build()) { json.decodeFromString<ReminderList>(it).reminders }

    suspend fun logout() = call(request("/api/auth/logout").post(ByteArray(0).toRequestBody()).build()) { }

    /** Blocking; called from WorkManager. */
    fun upload(
        file: File,
        mime: String,
        clientId: String,
        source: String,
        capturedAt: Long,
        note: String?,
        ocrText: String?,
        appPackage: String?,
        screenText: String? = null,
        sourceUrl: String? = null,
    ): Capture {
        val form = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("image", file.name, file.asRequestBody(mime.toMediaType()))
            .addFormDataPart("client_id", clientId)
            .addFormDataPart("source", source)
            .addFormDataPart("captured_at", capturedAt.toString())
        note?.takeIf { it.isNotBlank() }?.let { form.addFormDataPart("note", it) }
        ocrText?.takeIf { it.isNotBlank() }?.let { form.addFormDataPart("ocr_text", it) }
        appPackage?.let { form.addFormDataPart("app_package", it) }
        screenText?.takeIf { it.isNotBlank() }?.let { form.addFormDataPart("screen_text", it) }
        sourceUrl?.let { form.addFormDataPart("source_url", it) }
        val req = request("/api/captures").post(form.build()).build()
        Http.client.newCall(req).execute().use { res ->
            val body = res.body.string()
            if (!res.isSuccessful) throw ApiException(res.code, body.take(200))
            return json.decodeFromString(body)
        }
    }

    companion object {
        /** Swaps the one-time code from the sign-in redirect (plus our PKCE verifier) for a device token. */
        suspend fun exchange(serverUrl: String, code: String, verifier: String): String = withContext(Dispatchers.IO) {
            val body = buildJsonObject {
                put("code", code)
                put("verifier", verifier)
            }.toString().toRequestBody("application/json".toMediaType())
            val req = Request.Builder().url("$serverUrl/api/auth/oidc/exchange").post(body).build()
            Http.client.newCall(req).execute().use { res ->
                val parsed = runCatching { json.decodeFromString<LoginResponse>(res.body.string()) }.getOrNull()
                if (!res.isSuccessful || parsed?.token == null) {
                    throw ApiException(res.code, parsed?.error ?: "HTTP ${res.code}")
                }
                parsed.token
            }
        }
    }
}

fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
