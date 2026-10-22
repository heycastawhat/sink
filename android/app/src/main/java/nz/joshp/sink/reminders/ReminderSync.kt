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
import nz.joshp.sink.widget.SinkWidget
import java.util.concurrent.TimeUnit

/**
 * Pulls upcoming reminders from the server. New suggestions get a "Remind you?" notification once;
 * accepted ones (here or on the web) get an alarm. Runs every 15 min and shortly after each upload.
 */
object ReminderSync {
    private const val PERIODIC = "reminder-sync"
    private const val SOON = "reminder-sync-soon"
    private const val PREFS = "reminders"
    private const val OFFERED = "offered"
    private const val ALERTED = "alerted"

    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun schedulePeriodic(context: Context) {
        val req = PeriodicWorkRequestBuilder<ReminderSyncWorker>(15, TimeUnit.MINUTES).setConstraints(online).build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, req)
    }

    /** After an upload: give the AI time to read it, then look for new reminders. */
    fun soon(context: Context, delaySeconds: Long = 45) {
        val req = OneTimeWorkRequestBuilder<ReminderSyncWorker>()
            .setInitialDelay(delaySeconds, TimeUnit.SECONDS)
            .setConstraints(online)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(SOON, ExistingWorkPolicy.REPLACE, req)
    }

    fun now(context: Context) = soon(context, 0)

    internal fun offered(context: Context): MutableSet<String> =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getStringSet(OFFERED, emptySet())!!.toMutableSet()

    internal fun alerted(context: Context): MutableSet<String> =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getStringSet(ALERTED, emptySet())!!.toMutableSet()

    internal fun saveAlerted(context: Context, ids: Set<String>) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putStringSet(ALERTED, ids).apply()
    }

    internal fun saveOffered(context: Context, ids: Set<String>) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putStringSet(OFFERED, ids).apply()
    }
}

class ReminderSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val session = Settings(applicationContext).session() ?: return Result.success()
        val reminders = runCatching { Api(session).reminders() }.getOrElse { return Result.retry() }

        val offered = ReminderSync.offered(applicationContext)
        for (r in reminders) {
            when (r.state) {
                "accepted" -> Reminders.schedule(applicationContext, r)
                "suggested" -> if (offered.add(r.id)) Reminders.offer(applicationContext, r)
            }
        }
        // Forget ids the server no longer lists so the set doesn't grow forever.
        ReminderSync.saveOffered(applicationContext, offered.intersect(reminders.map { it.id }.toSet()))
        // Price drops: notify each once. A failure here shouldn't hold up reminders.
        runCatching { Api(session).alerts() }.getOrNull()?.let { alerts ->
            val alerted = ReminderSync.alerted(applicationContext)
            for (a in alerts) if (alerted.add(a.id)) Reminders.alert(applicationContext, a)
            ReminderSync.saveAlerted(applicationContext, alerted.intersect(alerts.map { it.id }.toSet()))
        }

        // Runs shortly after each upload too, by which time the AI has titled it.
        SinkWidget.refresh(applicationContext)
        return Result.success()
    }
}
