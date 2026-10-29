package nz.joshp.sink.capture

import android.app.PendingIntent
import android.content.Intent
import android.service.quicksettings.TileService
import nz.joshp.sink.ui.MainActivity

/** Quick Settings "New note": opens a fresh draft, Keep-style. */
class NoteTileService : TileService() {
    override fun onClick() {
        val intent = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(MainActivity.EXTRA_NEW_NOTE, true)
        startActivityAndCollapse(PendingIntent.getActivity(this, 1, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
    }
}
