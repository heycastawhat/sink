package nz.joshp.sink

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import nz.joshp.sink.data.Settings
import nz.joshp.sink.reminders.ReminderSync
import nz.joshp.sink.reminders.Reminders

class SinkApp : Application() {
    val settings by lazy { Settings(this) }

    /** Work that has to outlive a screen, such as a request sent just before a rotation recreates the activity. */
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    override fun onCreate() {
        super.onCreate()
        Reminders.createChannels(this)
        ReminderSync.schedulePeriodic(this)
    }
}
