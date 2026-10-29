package nz.joshp.sink.reminders

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat

/** Notification setup shared by todo reminders. */
object Reminders {
    const val CHANNEL_DUE = "reminders_due"

    // Channels from the screenshot days; removed so they don't linger in the app's notification settings.
    private val OLD_CHANNELS = listOf("reminder_offers", "price_drops")

    fun createChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_DUE, "Reminders", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Todos with a due date or reminder time"
            },
        )
        for (id in OLD_CHANNELS) nm.deleteNotificationChannel(id)
    }

    fun canNotify(context: Context) =
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
}
