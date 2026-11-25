package nz.joshp.sink.capture

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.widget.RemoteViews
import nz.joshp.sink.R

/**
 * The home-screen widget: two buttons, "Take a note" and "Add todo", that open Sink straight into a new note or the
 * new-todo dialog. It shows no data of its own, so it never needs refreshing (updateOnPeriodMillis is 0).
 */
class CaptureWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        val views = RemoteViews(context.packageName, R.layout.widget_capture).apply {
            setOnClickPendingIntent(R.id.widget_note, Capture.pending(context, Capture.Kind.NOTE, widget = true))
            setOnClickPendingIntent(R.id.widget_todo, Capture.pending(context, Capture.Kind.TODO, widget = true))
        }
        manager.updateAppWidget(appWidgetIds, views)
    }
}
