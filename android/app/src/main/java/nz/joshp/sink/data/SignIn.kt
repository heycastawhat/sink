package nz.joshp.sink.data

import android.content.Context
import android.net.Uri
import android.os.Build
import androidx.browser.customtabs.CustomTabsIntent
import java.security.MessageDigest
import java.security.SecureRandom
import android.util.Base64

/**
 * authentik sign-in: open the server's OIDC start URL in a Custom Tab, then the server redirects
 * back to nz.joshp.sink://auth?code=… and we exchange that code with a PKCE verifier only this app knows.
 */
object SignIn {
    private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    suspend fun start(context: Context, settings: Settings, serverUrl: String) {
        val verifier = b64(ByteArray(48).also(SecureRandom()::nextBytes))
        val challenge = b64(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))
        settings.savePendingLogin(serverUrl, verifier)
        val url = Uri.parse("$serverUrl/api/auth/oidc/start").buildUpon()
            .appendQueryParameter("client", "android")
            .appendQueryParameter("device", "${Build.MANUFACTURER} ${Build.MODEL}")
            .appendQueryParameter("challenge", challenge)
            .build()
        CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, url)
    }

    fun isCallback(uri: Uri?) = uri?.scheme == "nz.joshp.sink" && uri.host == "auth"

    /** Returns null on success, or an error message. */
    suspend fun complete(settings: Settings, uri: Uri): String? {
        val code = uri.getQueryParameter("code") ?: return "Sign-in was cancelled"
        val (server, verifier) = settings.takePendingLogin() ?: return "Sign-in expired, try again"
        return try {
            settings.saveSession(server, Api.exchange(server, code, verifier))
            null
        } catch (e: Exception) {
            e.message ?: "Couldn't finish signing in"
        }
    }
}
