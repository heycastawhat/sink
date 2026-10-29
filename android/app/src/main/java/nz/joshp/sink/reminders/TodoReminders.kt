package nz.joshp.sink.reminders

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import nz.joshp.sink.R
import nz.joshp.sink.data.Api
import nz.joshp.sink.data.Settings
import nz.joshp.sink.data.Todo
import nz.joshp.sink.data.todos
import nz.joshp.sink.data.toggleTodo
import nz.joshp.sink.ui.MainActivity

/**
 * Alarms for todos with a due date or reminder time (`📅 2026-11-02`, `(@2026-11-02 18:00)`). The server works out
 * `remind_at`; the phone schedules it. Synced with the other reminders, so ticking a todo anywhere cancels it.
 */
object TodoReminders {
    private const val PREFS = "todo_reminders"
    private const val SCHEDULED = "scheduled"
    private const val WINDOW_MS = 5 * 60 * 1000L

    private fun id(t: Todo) = t.key.hashCode()

    private fun fireIntent(context: Context, t: Todo): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            id(t),
            Intent(context, TodoReminderReceiver::class.java)
                .setAction(TodoReminderReceiver.ACTION_FIRE)
                .putExtra(TodoReminderReceiver.EXTRA_PATH, t.path)
                .putExtra(TodoReminderReceiver.EXTRA_LINE, t.line)
                .putExtra(TodoReminderReceiver.EXTRA_RAW, t.raw)
                .putExtra(TodoReminderReceiver.EXTRA_TEXT, t.text)
                .putExtra(TodoReminderReceiver.EXTRA_NOTE, t.noteTitle),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    /** Schedules every future reminder and cancels the ones that went away (ticked, deleted, re-dated). */
    suspend fun sync(context: Context, api: Api) {
        val todos = api.todos("open").todos
        val now = System.currentTimeMillis()
        val am = context.getSystemService(AlarmManager::class.java)
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val before = prefs.getStringSet(SCHEDULED, emptySet())!!
        val upcoming = todos.filter { (it.remindAt ?: 0) > now }
        for (t in upcoming) am.setWindow(AlarmManager.RTC_WAKEUP, t.remindAt!!, WINDOW_MS, fireIntent(context, t))
        val keep = upcoming.map { "${id(it)}" }.toSet()
        for (gone in before - keep) {
            val request = gone.toIntOrNull() ?: continue
            PendingIntent.getBroadcast(
                context,
                request,
                Intent(context, TodoReminderReceiver::class.java).setAction(TodoReminderReceiver.ACTION_FIRE),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_NO_CREATE,
            )?.let { am.cancel(it); it.cancel() }
        }
        prefs.edit().putStringSet(SCHEDULED, keep).apply()
    }

    fun fire(context: Context, intent: Intent) {
        if (!Reminders.canNotify(context)) return
        val path = intent.getStringExtra(TodoReminderReceiver.EXTRA_PATH) ?: return
        val line = intent.getIntExtra(TodoReminderReceiver.EXTRA_LINE, 0)
        val text = intent.getStringExtra(TodoReminderReceiver.EXTRA_TEXT) ?: "Todo"
        val id = (path + intent.getStringExtra(TodoReminderReceiver.EXTRA_RAW)).hashCode()
        val open = PendingIntent.getActivity(
            context,
            id,
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(MainActivity.EXTRA_OPEN_NOTE, path)
                .putExtra(MainActivity.EXTRA_OPEN_LINE, line),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val done = PendingIntent.getBroadcast(
            context,
            id + 1,
            Intent(intent).setClass(context, TodoReminderReceiver::class.java).setAction(TodoReminderReceiver.ACTION_DONE),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(context, Reminders.CHANNEL_DUE)
            .setSmallIcon(R.drawable.ic_tile)
            .setContentTitle(text)
            .setContentText(intent.getStringExtra(TodoReminderReceiver.EXTRA_NOTE)?.let { "In $it" } ?: "Todo")
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(open)
            .setAutoCancel(true)
            .addAction(0, "Done", done)
            .build()
        NotificationManagerCompat.from(context).notify(id, n)
    }
}

class TodoReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_FIRE -> TodoReminders.fire(context, intent)
            ACTION_DONE -> {
                val path = intent.getStringExtra(EXTRA_PATH) ?: return
                val raw = intent.getStringExtra(EXTRA_RAW) ?: return
                NotificationManagerCompat.from(context).cancel((path + raw).hashCode())
                val pending = goAsync()
                CoroutineScope(Dispatchers.IO).launch {
                    try {
                        val api = Settings(context).session()?.let(::Api) ?: return@launch
                        val todo = Todo(path, intent.getIntExtra(EXTRA_LINE, 0), raw, intent.getStringExtra(EXTRA_TEXT) ?: "", "open")
                        runCatching { api.toggleTodo(todo, true) }
                    } finally {
                        pending.finish()
                    }
                }
            }
        }
    }

    companion object {
        const val ACTION_FIRE = "nz.joshp.sink.todo.FIRE"
        const val ACTION_DONE = "nz.joshp.sink.todo.DONE"
        const val EXTRA_PATH = "path"
        const val EXTRA_LINE = "line"
        const val EXTRA_RAW = "raw"
        const val EXTRA_TEXT = "text"
        const val EXTRA_NOTE = "note"
    }
}
