package nz.joshp.sink

import android.app.Application
import nz.joshp.sink.data.Settings
import nz.joshp.sink.reminders.ReminderSync
import nz.joshp.sink.reminders.Reminders

class SinkApp : Application() {
    val settings by lazy { Settings(this) }

    override fun onCreate() {
        super.onCreate()
        Reminders.createChannels(this)
        ReminderSync.schedulePeriodic(this)
    }
}
