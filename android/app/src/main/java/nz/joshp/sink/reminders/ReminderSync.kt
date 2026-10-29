package nz.joshp.sink.reminders

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import nz.joshp.sink.data.Api
import nz.joshp.sink.data.Settings
import java.util.concurrent.TimeUnit

/** Keeps the phone's todo alarms in line with the notes: every 15 min, and right after a todo changes here. */
object ReminderSync {
    private const val PERIODIC = "reminder-sync"
    private const val SOON = "reminder-sync-soon"

    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun schedulePeriodic(context: Context) {
        val req = PeriodicWorkRequestBuilder<ReminderSyncWorker>(15, TimeUnit.MINUTES).setConstraints(online).build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, req)
    }

    fun now(context: Context) {
        val req = OneTimeWorkRequestBuilder<ReminderSyncWorker>().setConstraints(online).build()
        WorkManager.getInstance(context).enqueueUniqueWork(SOON, ExistingWorkPolicy.REPLACE, req)
    }
}

class ReminderSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val session = Settings(applicationContext).session() ?: return Result.success()
        return runCatching { TodoReminders.sync(applicationContext, Api(session)) }.fold({ Result.success() }, { Result.retry() })
    }
}
