package nz.joshp.sink.capture

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.flow.first
import nz.joshp.sink.data.Settings
import java.util.concurrent.TimeUnit

/**
 * Pixel Screenshots behaviour: new files in Screenshots/ get stashed automatically.
 *
 * Uses a content-URI-triggered WorkRequest (JobScheduler under the hood), so it fires even
 * when the app isn't running. Each run re-arms the trigger for the next screenshot.
 */
object ScreenshotWatcher {
    private const val WORK = "screenshot-watcher"

    fun hasPermission(context: Context) =
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED ||
            (android.os.Build.VERSION.SDK_INT < 33 &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED)

    fun arm(context: Context) {
        val constraints = Constraints.Builder()
            .addContentUriTrigger(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true)
            .setTriggerContentUpdateDelay(1, TimeUnit.SECONDS)
            .setTriggerContentMaxDelay(5, TimeUnit.SECONDS)
            .build()
        val request = OneTimeWorkRequestBuilder<ScreenshotImportWorker>().setConstraints(constraints).build()
        WorkManager.getInstance(context).enqueueUniqueWork(WORK, ExistingWorkPolicy.REPLACE, request)
    }

    fun disarm(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(WORK)
    }
}

class ScreenshotImportWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val settings = Settings(applicationContext)
        try {
            if (!settings.autoImport.first() || settings.session() == null || !ScreenshotWatcher.hasPermission(applicationContext)) {
                return Result.success()
            }
            importNew(settings)
        } finally {
            if (settings.autoImport.first()) ScreenshotWatcher.arm(applicationContext)
        }
        return Result.success()
    }

    private suspend fun importNew(settings: Settings) {
        val since = settings.lastImportedAt()
        var newest = since
        val projection = arrayOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DATE_ADDED,
            MediaStore.Images.Media.DATE_TAKEN,
            MediaStore.Images.Media.OWNER_PACKAGE_NAME,
        )
        // Pending files are still being written by SystemUI; they show up again once finished.
        val selection = "${MediaStore.Images.Media.DATE_ADDED} > ? AND ${MediaStore.Images.Media.IS_PENDING} = 0 AND " +
            "(${MediaStore.Images.Media.RELATIVE_PATH} LIKE ? OR ${MediaStore.Images.Media.BUCKET_DISPLAY_NAME} = ?)"
        val args = arrayOf(since.toString(), "%Screenshots%", "Screenshots")

        val found = mutableListOf<Triple<Long, Long, Long>>()
        applicationContext.contentResolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            projection,
            selection,
            args,
            "${MediaStore.Images.Media.DATE_ADDED} ASC",
        )?.use { c ->
            val idCol = c.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            val addedCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED)
            val takenCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_TAKEN)
            while (c.moveToNext()) {
                found += Triple(c.getLong(idCol), c.getLong(addedCol), c.getLong(takenCol))
            }
        }

        for ((id, added, taken) in found.take(20)) {
            val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
            val staged = runCatching {
                CaptureQueue.stage(applicationContext, uri, if (taken > 0) taken else added * 1000)
            }.getOrNull() ?: continue
            CaptureQueue.enqueue(applicationContext, staged, note = null, source = "auto")
            newest = maxOf(newest, added)
        }
        if (newest > since) settings.setLastImportedAt(newest)
    }
}
