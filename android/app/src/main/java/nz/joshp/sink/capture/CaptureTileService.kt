package nz.joshp.sink.capture

import android.app.PendingIntent
import android.content.Intent
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import nz.joshp.sink.ui.MainActivity

class CaptureTileService : TileService() {
    override fun onStartListening() {
        qsTile?.apply {
            state = if (CaptureAccessibilityService.instance != null) Tile.STATE_INACTIVE else Tile.STATE_UNAVAILABLE
            subtitle = if (CaptureAccessibilityService.instance != null) null else "Set up in app"
            updateTile()
        }
    }

    override fun onClick() {
        val service = CaptureAccessibilityService.instance
        if (service != null) {
            // Let the shade animate away before grabbing the screen.
            service.capture(delayMs = 650, closeShade = true)
        } else {
            val intent = Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(MainActivity.EXTRA_OPEN_SETTINGS, true)
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE))
        }
    }
}
