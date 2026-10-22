package nz.joshp.sink.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore("settings")

data class Session(val serverUrl: String, val token: String)

class Settings(private val context: Context) {
    private object Keys {
        val server = stringPreferencesKey("server_url")
        val token = stringPreferencesKey("token")
        val autoImport = booleanPreferencesKey("auto_import")
        val dynamicColor = booleanPreferencesKey("dynamic_color")
        val themeMode = stringPreferencesKey("theme_mode")
        val floatingButton = booleanPreferencesKey("floating_button")
        val lastImportedAt = longPreferencesKey("last_imported_at")
        val pendingServer = stringPreferencesKey("pending_server")
        val pendingVerifier = stringPreferencesKey("pending_verifier")
    }

    val session: Flow<Session?> = context.dataStore.data.map { p ->
        val server = p[Keys.server]
        val token = p[Keys.token]
        if (server != null && token != null) Session(server, token) else null
    }

    val lastServerUrl: Flow<String?> = context.dataStore.data.map { it[Keys.server] }

    // Pixel Screenshots behaviour: on unless turned off.
    val autoImport: Flow<Boolean> = context.dataStore.data.map { it[Keys.autoImport] ?: true }
    val dynamicColor: Flow<Boolean> = context.dataStore.data.map { it[Keys.dynamicColor] ?: false }

    /** "auto" follows the system; "light" / "dark" pin it. */
    val themeMode: Flow<String> = context.dataStore.data.map { it[Keys.themeMode] ?: "auto" }

    suspend fun setThemeMode(mode: String) {
        context.dataStore.edit { it[Keys.themeMode] = mode }
    }

    // Accessibility floating button. Off by default: hold-power (assistant) is the main way in.
    val floatingButton: Flow<Boolean> = context.dataStore.data.map { it[Keys.floatingButton] ?: false }

    suspend fun setFloatingButton(on: Boolean) {
        context.dataStore.edit { it[Keys.floatingButton] = on }
    }

    suspend fun session(): Session? = session.first()

    suspend fun saveSession(serverUrl: String, token: String) {
        context.dataStore.edit {
            it[Keys.server] = serverUrl
            it[Keys.token] = token
            // Only import screenshots taken from now on, not the whole back catalogue.
            if (it[Keys.lastImportedAt] == null) it[Keys.lastImportedAt] = System.currentTimeMillis() / 1000
        }
    }

    /** Survives the app being killed while the browser is open for sign-in. */
    suspend fun savePendingLogin(serverUrl: String, verifier: String) {
        context.dataStore.edit {
            it[Keys.pendingServer] = serverUrl
            it[Keys.pendingVerifier] = verifier
            it[Keys.server] = serverUrl
        }
    }

    suspend fun takePendingLogin(): Pair<String, String>? {
        var result: Pair<String, String>? = null
        context.dataStore.edit {
            val server = it[Keys.pendingServer]
            val verifier = it[Keys.pendingVerifier]
            if (server != null && verifier != null) result = server to verifier
            it.remove(Keys.pendingServer)
            it.remove(Keys.pendingVerifier)
        }
        return result
    }

    suspend fun clearToken() {
        context.dataStore.edit { it.remove(Keys.token) }
    }

    suspend fun setAutoImport(on: Boolean) {
        context.dataStore.edit {
            it[Keys.autoImport] = on
            if (on) it[Keys.lastImportedAt] = System.currentTimeMillis() / 1000
        }
    }

    suspend fun setDynamicColor(on: Boolean) {
        context.dataStore.edit { it[Keys.dynamicColor] = on }
    }

    suspend fun lastImportedAt(): Long =
        context.dataStore.data.first()[Keys.lastImportedAt] ?: (System.currentTimeMillis() / 1000)

    suspend fun setLastImportedAt(seconds: Long) {
        context.dataStore.edit { it[Keys.lastImportedAt] = seconds }
    }
}
