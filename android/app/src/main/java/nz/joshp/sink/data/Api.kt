package nz.joshp.sink.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

@Serializable
private data class LoginResponse(val token: String? = null, val error: String? = null)

@Serializable
private data class ErrorResponse(val error: String? = null)

/** A non-2xx reply; [body] is the raw response (a 409 on a note save carries the current note). */
class ApiException(val code: Int, message: String, val body: String? = null) : IOException(message)

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
    internal val base = session.serverUrl
    internal val token = session.token

    fun absolute(path: String) = base + path

    internal fun request(path: String) = Request.Builder()
        .url(base + path)
        .header("Authorization", "Bearer ${session.token}")

    internal suspend fun <T> call(req: Request, parse: (String) -> T): T = withContext(Dispatchers.IO) {
        Http.client.newCall(req).execute().use { res ->
            val body = res.body.string()
            if (!res.isSuccessful) {
                val msg = runCatching { json.decodeFromString<ErrorResponse>(body).error }.getOrNull()
                throw ApiException(res.code, msg ?: "HTTP ${res.code}", body)
            }
            parse(body)
        }
    }

    internal fun jsonBody(obj: JsonObject) = obj.toString().toRequestBody("application/json".toMediaType())

    suspend fun logout() = call(request("/api/auth/logout").post(ByteArray(0).toRequestBody()).build()) { }

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
