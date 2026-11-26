package nz.joshp.sink.capture

import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/** A Quick Settings tile that is a button, not a toggle: tapping it collapses the shade and opens Sink on [kind]. */
abstract class CaptureTileService(private val kind: Capture.Kind) : TileService() {
    override fun onStartListening() {
        // An action tile has no on/off; inactive is the plain look.
        qsTile?.apply {
            state = Tile.STATE_INACTIVE
            updateTile()
        }
    }

    override fun onClick() {
        // The PendingIntent overload only exists from API 34; before that the Intent one is the way.
        if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(Capture.pending(this, kind))
        else @Suppress("DEPRECATION") startActivityAndCollapse(Capture.intent(this, kind))
    }
}

/** Quick Settings "Take a note": opens a fresh draft, Keep-style. */
class NoteTileService : CaptureTileService(Capture.Kind.NOTE)

/** Quick Settings "Add todo": opens the new-todo dialog, which saves to Todo.md. */
class TodoTileService : CaptureTileService(Capture.Kind.TODO)
