package nz.joshp.sink.capture

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import nz.joshp.sink.data.Api
import nz.joshp.sink.data.ApiException
import nz.joshp.sink.data.Settings
import nz.joshp.sink.data.json
import nz.joshp.sink.data.str
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import nz.joshp.sink.reminders.ReminderSync
import nz.joshp.sink.widget.SinkWidget
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

/** An image copied into app storage, waiting for a note and then upload. */
data class Staged(val path: String, val mime: String, val capturedAt: Long)

const val UPLOAD_TAG = "upload"

object CaptureQueue {
    private fun queueDir(context: Context) = File(context.filesDir, "queue").apply { mkdirs() }

    suspend fun stage(context: Context, uri: Uri, capturedAt: Long = System.currentTimeMillis()): Staged =
        withContext(Dispatchers.IO) {
            val mime = context.contentResolver.getType(uri) ?: "image/png"
            val ext = when (mime) {
                "image/jpeg" -> "jpg"
                "image/webp" -> "webp"
                else -> "png"
            }
            val file = File(queueDir(context), "${UUID.randomUUID()}.$ext")
            context.contentResolver.openInputStream(uri)?.use { input ->
                FileOutputStream(file).use { input.copyTo(it) }
            } ?: throw IOException("Couldn't open image")
            Staged(file.path, mime, capturedAt)
        }

    suspend fun stage(context: Context, bitmap: Bitmap): Staged = withContext(Dispatchers.IO) {
        val file = File(queueDir(context), "${UUID.randomUUID()}.png")
        FileOutputStream(file).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        Staged(file.path, "image/png", System.currentTimeMillis())
    }

    /** Screen text + page URL from the assistant ride along in a sidecar file (too big for WorkManager data). */
    fun attachScreenContext(staged: Staged, screenText: String?, sourceUrl: String?) {
        if (screenText == null && sourceUrl == null) return
        val obj = buildJsonObject {
            screenText?.let { put("screen_text", it) }
            sourceUrl?.let { put("source_url", it) }
        }
        sidecar(staged.path).writeText(obj.toString())
    }

    internal fun sidecar(path: String) = File("$path.context.json")

    fun discard(staged: Staged) {
        File(staged.path).delete()
        sidecar(staged.path).delete()
    }

    fun enqueue(context: Context, staged: Staged, note: String?, source: String, appPackage: String? = null) {
        val clientId = File(staged.path).nameWithoutExtension
        val request = OneTimeWorkRequestBuilder<UploadWorker>()
            .setInputData(
                workDataOf(
                    "path" to staged.path,
                    "mime" to staged.mime,
                    "client_id" to clientId,
                    "source" to source,
                    "captured_at" to staged.capturedAt,
                    "note" to note,
                    "app_package" to appPackage,
                ),
            )
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .addTag(UPLOAD_TAG)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork("upload-$clientId", ExistingWorkPolicy.KEEP, request)
    }
}

class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val path = inputData.getString("path") ?: return@withContext Result.failure()
        val file = File(path)
        if (!file.exists()) return@withContext Result.failure()

        val session = Settings(applicationContext).session() ?: return@withContext Result.retry()

        // On-device OCR is free and offline; the server only has to run its own if this fails.
        val ocrText = runCatching { recognize(file) }.getOrNull()
        val screen = CaptureQueue.sidecar(path).takeIf { it.exists() }
            ?.let { runCatching { json.parseToJsonElement(it.readText()).jsonObject }.getOrNull() }

        try {
            Api(session).upload(
                file = file,
                mime = inputData.getString("mime") ?: "image/png",
                clientId = inputData.getString("client_id")!!,
                source = inputData.getString("source") ?: "share",
                capturedAt = inputData.getLong("captured_at", System.currentTimeMillis()),
                note = inputData.getString("note"),
                ocrText = ocrText,
                appPackage = inputData.getString("app_package"),
                screenText = screen?.str("screen_text"),
                sourceUrl = screen?.str("source_url"),
            )
            file.delete()
            CaptureQueue.sidecar(path).delete()
            // The AI may find a deadline in it; check for reminder suggestions once it has had a look.
            ReminderSync.soon(applicationContext)
            SinkWidget.refresh(applicationContext)
            Result.success()
        } catch (e: ApiException) {
            when {
                // Logged out: keep the file and try again once there is a new token.
                e.code == 401 -> Result.retry()
                e.code in 400..499 -> {
                    file.delete()
                    CaptureQueue.sidecar(path).delete()
                    Result.failure()
                }
                else -> Result.retry()
            }
        } catch (e: IOException) {
            Result.retry()
        }
    }

    private fun recognize(file: File): String? {
        val image = InputImage.fromFilePath(applicationContext, android.net.Uri.fromFile(file))
        val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
        return try {
            Tasks.await(recognizer.process(image), 20, TimeUnit.SECONDS).text.takeIf { it.isNotBlank() }
        } finally {
            recognizer.close()
        }
    }
}
