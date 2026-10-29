package nz.joshp.sink.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import okhttp3.Request

/** A newer Sink release on GitHub, with its signed APK. */
data class Update(val version: String, val apkUrl: String, val pageUrl: String)

@Serializable
private data class Release(
    @SerialName("tag_name") val tag: String,
    @SerialName("html_url") val page: String,
    val draft: Boolean = false,
    val prerelease: Boolean = false,
    val assets: List<Asset> = emptyList(),
)

@Serializable
private data class Asset(val name: String, @SerialName("browser_download_url") val url: String)

/**
 * The APK is sideloaded, so nothing else tells people a new one is out: ask GitHub for the latest release
 * (the Android workflow attaches sink-<version>.apk to each one) and compare it with this build.
 */
object Updates {
    const val REPO = "heycastawhat/sink"
    const val DAY_MS = 24 * 60 * 60 * 1000L

    /** The latest release if it's newer than [current], else null. Throws when GitHub can't be reached. */
    suspend fun check(current: String): Update? = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url("https://api.github.com/repos/$REPO/releases/latest")
            .header("Accept", "application/vnd.github+json")
            .build()
        val release = Http.client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw ApiException(res.code, "GitHub said ${res.code}")
            json.decodeFromString<Release>(res.body.string())
        }
        val version = release.tag.removePrefix("v")
        val apk = release.assets.firstOrNull { it.name.endsWith(".apk") } ?: return@withContext null
        if (release.draft || release.prerelease || !isNewer(version, current)) return@withContext null
        Update(version, apk.url, release.page)
    }

    /** Semver-ish: 0.3.0 > 0.2.1, and a release beats a pre-release of the same number (0.2.0 > 0.2.0-dev.4). */
    fun isNewer(latest: String, current: String): Boolean {
        fun parts(v: String) = v.substringBefore('-').split('.').map { it.toIntOrNull() ?: 0 }
        val a = parts(latest)
        val b = parts(current)
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }
            val y = b.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return '-' in current && '-' !in latest
    }
}
