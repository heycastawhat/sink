package nz.joshp.sink.reminders

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import nz.joshp.sink.R
import nz.joshp.sink.data.Alert
import nz.joshp.sink.data.Reminder
import nz.joshp.sink.data.str
import nz.joshp.sink.ui.MainActivity
import java.text.DateFormat
import java.util.Date

/**
 * Local reminders. The server suggests them (AI found a deadline in a screenshot); the phone asks
 * before scheduling anything, then fires a notification at the due time with Done / Snooze.
 */
object Reminders {
    const val CHANNEL_OFFERS = "reminder_offers"
    const val CHANNEL_DUE = "reminders_due"
    const val CHANNEL_ALERTS = "price_drops"

    // Alarms fire within this window after the due time. Inexact alarms need no special permission.
    private const val WINDOW_MS = 5 * 60 * 1000L

    fun createChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_OFFERS, "Reminder suggestions", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Sink found a date in a screenshot and asks whether to remind you"
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_DUE, "Reminders", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Reminders you set from screenshots"
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ALERTS, "Price drops", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "A product you're watching got cheaper"
            },
        )
    }

    fun canNotify(context: Context) =
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun notificationId(actionId: String) = actionId.hashCode()

    fun formatDue(ms: Long): String =
        DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(ms))

    private fun openCapture(context: Context, captureId: String, requestCode: Int): PendingIntent =
        PendingIntent.getActivity(
            context,
            requestCode,
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(MainActivity.EXTRA_OPEN_CAPTURE, captureId),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    private fun receiverIntent(context: Context, action: String, r: Reminder): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            (action + r.id).hashCode(),
            Intent(context, ReminderReceiver::class.java)
                .setAction(action)
                .putExtra(ReminderReceiver.EXTRA_ID, r.id)
                .putExtra(ReminderReceiver.EXTRA_CAPTURE, r.captureId)
                .putExtra(ReminderReceiver.EXTRA_TEXT, r.text)
                .putExtra(ReminderReceiver.EXTRA_DUE, r.dueAt)
                .putExtra(ReminderReceiver.EXTRA_TITLE, r.captureTitle),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    /** "Set a reminder?" for a fresh suggestion. */
    fun offer(context: Context, r: Reminder) {
        if (!canNotify(context)) return
        val n = NotificationCompat.Builder(context, CHANNEL_OFFERS)
            .setSmallIcon(R.drawable.ic_tile)
            .setContentTitle("Remind you? ${r.text}")
            .setContentText("${formatDue(r.dueAt)}${r.captureTitle?.let { " · from $it" } ?: ""}")
            .setContentIntent(openCapture(context, r.captureId, notificationId(r.id)))
            .setAutoCancel(true)
            .addAction(0, "Remind me", receiverIntent(context, ReminderReceiver.ACTION_ACCEPT, r))
            .addAction(0, "No", receiverIntent(context, ReminderReceiver.ACTION_DECLINE, r))
            .build()
        NotificationManagerCompat.from(context).notify(notificationId(r.id), n)
    }

    fun schedule(context: Context, r: Reminder) {
        val am = context.getSystemService(AlarmManager::class.java)
        am.setWindow(AlarmManager.RTC_WAKEUP, r.dueAt, WINDOW_MS, receiverIntent(context, ReminderReceiver.ACTION_FIRE, r))
    }

    fun cancel(context: Context, r: Reminder) {
        context.getSystemService(AlarmManager::class.java).cancel(receiverIntent(context, ReminderReceiver.ACTION_FIRE, r))
    }

    /** The reminder itself, at the due time. */
    fun fire(context: Context, r: Reminder) {
        if (!canNotify(context)) return
        val n = NotificationCompat.Builder(context, CHANNEL_DUE)
            .setSmallIcon(R.drawable.ic_tile)
            .setContentTitle(r.text)
            .setContentText(r.captureTitle ?: "From a screenshot in Sink")
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(openCapture(context, r.captureId, notificationId(r.id)))
            .setAutoCancel(true)
            .addAction(0, "Done", receiverIntent(context, ReminderReceiver.ACTION_DONE, r))
            .addAction(0, "Snooze 1h", receiverIntent(context, ReminderReceiver.ACTION_SNOOZE, r))
            .build()
        NotificationManagerCompat.from(context).notify(notificationId(r.id), n)
    }

    /** A watched price dropped: tap opens the shop page, the action opens the capture. */
    fun alert(context: Context, a: Alert) {
        if (!canNotify(context)) return
        val id = notificationId(a.id)
        val url = a.payload.str("url")?.takeIf { it.startsWith("https://") || it.startsWith("http://") }
        val tap = url?.let {
            PendingIntent.getActivity(
                context,
                id,
                Intent(Intent.ACTION_VIEW, Uri.parse(it)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        } ?: openCapture(context, a.captureId, id)
        val n = NotificationCompat.Builder(context, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_tile)
            .setContentTitle(a.label)
            .setContentText(a.captureTitle ?: "A product you're watching in Sink")
            .setContentIntent(tap)
            .setAutoCancel(true)
            .addAction(0, "Open in Sink", openCapture(context, a.captureId, id + 1))
            .build()
        NotificationManagerCompat.from(context).notify(id, n)
    }

    fun dismiss(context: Context, actionId: String) {
        NotificationManagerCompat.from(context).cancel(notificationId(actionId))
    }
}
