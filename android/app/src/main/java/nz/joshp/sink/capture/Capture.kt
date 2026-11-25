package nz.joshp.sink.capture

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import nz.joshp.sink.ui.MainActivity

/**
 * The quick-capture entry points outside the app (the Quick Settings tiles and the home-screen widget): each opens
 * [MainActivity] with an extra that says what to start.
 */
object Capture {
    /** What a button starts: a blank note, or the new-todo dialog. */
    enum class Kind(val extra: String) {
        NOTE(MainActivity.EXTRA_NEW_NOTE),
        TODO(MainActivity.EXTRA_NEW_TODO),
    }

    fun intent(context: Context, kind: Kind): Intent =
        Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(kind.extra, true)

    /** For a tile or a widget button. PendingIntents match on everything but extras, so each needs its own request code. */
    fun pending(context: Context, kind: Kind, widget: Boolean = false): PendingIntent =
        PendingIntent.getActivity(
            context,
            1 + kind.ordinal + if (widget) 10 else 0,
            intent(context, kind),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
}
