package nz.joshp.sink.capture

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.core.content.IntentCompat
import java.io.File
import java.util.UUID

/**
 * Photos and PDFs shared into Sink. The permission to read a shared Uri only lasts while the activity does, so they're
 * copied into the app's cache straight away; the note screen uploads them and deletes the copies.
 */
object SharedFiles {
    private const val DIR = "shared"
    private const val DAY_MS = 24 * 60 * 60 * 1000L

    /** The streams an ACTION_SEND / ACTION_SEND_MULTIPLE intent carries. */
    fun uris(intent: Intent): List<Uri> = when (intent.action) {
        Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
        Intent.ACTION_SEND_MULTIPLE -> IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
        else -> emptyList()
    }

    /** Blocking: copies each Uri into the cache under its own name. Unreadable ones are skipped. */
    fun copy(context: Context, uris: List<Uri>): List<File> {
        val root = File(context.cacheDir, DIR)
        // Copies left behind by a share that never got uploaded (the app was killed first).
        root.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > DAY_MS }?.forEach { it.deleteRecursively() }
        return uris.mapNotNull { uri ->
            runCatching {
                val resolver = context.contentResolver
                val mime = resolver.getType(uri) ?: "application/octet-stream"
                val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)
                var name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                    if (c.moveToFirst()) c.getString(0) else null
                }?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: "Shared ${System.currentTimeMillis() / 1000}"
                if (ext != null && !name.contains('.')) name = "$name.$ext"
                val dest = File(root, UUID.randomUUID().toString()).apply { mkdirs() }.resolve(name)
                resolver.openInputStream(uri)!!.use { input -> dest.outputStream().use { input.copyTo(it) } }
                dest
            }.getOrNull()
        }
    }

    fun mimeOf(file: File): String =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase()) ?: "application/octet-stream"

    /** Done with a copy: remove it and the folder made for it. */
    fun discard(file: File) {
        file.parentFile?.takeIf { it.parentFile?.name == DIR }?.deleteRecursively() ?: file.delete()
    }
}
