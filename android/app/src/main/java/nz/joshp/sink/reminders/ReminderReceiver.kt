package nz.joshp.sink.reminders

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import nz.joshp.sink.data.Api
import nz.joshp.sink.data.Reminder
import nz.joshp.sink.data.Settings

/** Notification buttons, alarm firing, and rescheduling after reboot. */
class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            // Alarms don't survive a reboot or update; a sync puts accepted ones back.
            ReminderSync.now(context)
            return
        }

        val r = Reminder(
            id = intent.getStringExtra(EXTRA_ID) ?: return,
            captureId = intent.getStringExtra(EXTRA_CAPTURE) ?: return,
            type = "reminder",
            label = intent.getStringExtra(EXTRA_TEXT) ?: "",
            state = "accepted",
            dueAt = intent.getLongExtra(EXTRA_DUE, 0),
            captureTitle = intent.getStringExtra(EXTRA_TITLE),
        )

        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val api = Settings(context).session()?.let(::Api)
                when (intent.action) {
                    ACTION_FIRE -> Reminders.fire(context, r)
                    ACTION_ACCEPT -> {
                        Reminders.dismiss(context, r.id)
                        Reminders.schedule(context, r)
                        runCatching { api?.setAction(r.id, state = "accepted") }
                    }
                    ACTION_DECLINE -> {
                        Reminders.dismiss(context, r.id)
                        runCatching { api?.setAction(r.id, state = "dismissed") }
                    }
                    ACTION_DONE -> {
                        Reminders.dismiss(context, r.id)
                        runCatching { api?.setAction(r.id, state = "done") }
                    }
                    ACTION_SNOOZE -> {
                        Reminders.dismiss(context, r.id)
                        val later = r.copy(dueAt = System.currentTimeMillis() + SNOOZE_MS)
                        Reminders.schedule(context, later)
                        runCatching { api?.setAction(r.id, dueAt = later.dueAt) }
                    }
                }
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION_FIRE = "nz.joshp.sink.reminder.FIRE"
        const val ACTION_ACCEPT = "nz.joshp.sink.reminder.ACCEPT"
        const val ACTION_DECLINE = "nz.joshp.sink.reminder.DECLINE"
        const val ACTION_DONE = "nz.joshp.sink.reminder.DONE"
        const val ACTION_SNOOZE = "nz.joshp.sink.reminder.SNOOZE"
        const val EXTRA_ID = "id"
        const val EXTRA_CAPTURE = "capture"
        const val EXTRA_TEXT = "text"
        const val EXTRA_DUE = "due"
        const val EXTRA_TITLE = "title"
        private const val SNOOZE_MS = 60 * 60 * 1000L
    }
}
