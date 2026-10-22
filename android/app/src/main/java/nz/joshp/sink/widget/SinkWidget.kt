package nz.joshp.sink.widget

import android.content.Context
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.action.Action
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.updateAll
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.RowScope
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import nz.joshp.sink.R
import nz.joshp.sink.data.Api
import nz.joshp.sink.data.Capture
import nz.joshp.sink.data.Reminder
import nz.joshp.sink.data.Settings
import java.text.SimpleDateFormat
import java.util.Locale
import nz.joshp.sink.ui.MainActivity
import nz.joshp.sink.ui.relativeDay
import nz.joshp.sink.ui.timeOf

/** What the widget shows; null lists mean the server couldn't be reached this time. */
private data class WidgetData(
    val signedIn: Boolean,
    val reminders: List<Reminder>?,
    val recent: List<Capture>?,
)

/** Home-screen widget: next reminders and latest captures, each tap opening that capture. */
class SinkWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val data = load(context)
        provideContent { GlanceTheme { Content(context, data) } }
    }

    private suspend fun load(context: Context): WidgetData {
        val session = Settings(context).session() ?: return WidgetData(false, null, null)
        val api = Api(session)
        return coroutineScope {
            val reminders = async { runCatching { api.reminders().take(3) }.getOrNull() }
            val recent = async { runCatching { api.list(null, null, null, "all", null, limit = 6).items }.getOrNull() }
            WidgetData(true, reminders.await(), recent.await())
        }
    }

    companion object {
        /** Re-render every placed widget; cheap no-op when none are placed. */
        suspend fun refresh(context: Context) {
            runCatching { SinkWidget().updateAll(context) }
        }
    }
}

class SinkWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget = SinkWidget()
}

private fun openApp(context: Context): Action = actionStartActivity(Intent(context, MainActivity::class.java))

// Distinct identifiers so each row gets its own PendingIntent instead of all sharing the first one's extras.
private fun openCapture(context: Context, captureId: String): Action = actionStartActivity(
    Intent(context, MainActivity::class.java)
        .setIdentifier("capture:$captureId")
        .putExtra(MainActivity.EXTRA_OPEN_CAPTURE, captureId),
)

@Composable
private fun Content(context: Context, data: WidgetData) {
    Column(
        GlanceModifier
            .fillMaxSize()
            .background(GlanceTheme.colors.widgetBackground)
            .cornerRadius(24.dp)
            .padding(horizontal = 14.dp, vertical = 12.dp),
    ) {
        Row(
            GlanceModifier.fillMaxWidth().clickable(openApp(context)),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Image(ImageProvider(R.drawable.ic_launcher_foreground), null, GlanceModifier.size(26.dp))
            Spacer(GlanceModifier.width(6.dp))
            Text("Sink", style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 16.sp, fontWeight = FontWeight.Bold))
        }
        Spacer(GlanceModifier.height(8.dp))

        if (!data.signedIn) {
            Muted("Open Sink to sign in.")
            return@Column
        }
        if (data.reminders == null && data.recent == null) {
            Muted("Can't reach the sink right now.")
            return@Column
        }

        LazyColumn(GlanceModifier.fillMaxWidth()) {
            val reminders = data.reminders.orEmpty()
            if (reminders.isNotEmpty()) {
                item { SectionLabel("Coming up") }
                for (r in reminders) {
                    item {
                        Row(
                            GlanceModifier
                                .fillMaxWidth()
                                .padding(vertical = 3.dp)
                                .clickable(openCapture(context, r.captureId)),
                        ) {
                            Pill(shortDue(r.dueAt))
                            Spacer(GlanceModifier.width(8.dp))
                            Line(r.text)
                        }
                    }
                }
                item { Spacer(GlanceModifier.height(6.dp)) }
            }
            val recent = data.recent.orEmpty()
            item { SectionLabel("Recent") }
            if (recent.isEmpty()) item { Muted("Nothing stashed yet.") }
            for (c in recent) {
                item {
                    Row(
                        GlanceModifier
                            .fillMaxWidth()
                            .padding(vertical = 3.dp)
                            .clickable(openCapture(context, c.id)),
                    ) {
                        Line(c.title ?: c.note ?: if (c.busy) "Reading…" else "Untitled")
                        Spacer(GlanceModifier.width(8.dp))
                        Text(
                            "${relativeDay(c.createdAt)} ${timeOf(c.createdAt)}",
                            style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 11.sp),
                            maxLines = 1,
                        )
                    }
                }
            }
        }
    }
}

/** Widget-width due time: "Fri 8:54 pm" this week, "23 Oct" after that. */
private fun shortDue(ms: Long): String {
    val week = ms - System.currentTimeMillis() < 6L * 24 * 3600_000
    val pattern = if (week) "EEE h:mm a" else "d MMM"
    return SimpleDateFormat(pattern, Locale.getDefault()).format(ms)
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text,
        style = TextStyle(color = GlanceTheme.colors.primary, fontSize = 12.sp, fontWeight = FontWeight.Medium),
        modifier = GlanceModifier.padding(bottom = 2.dp),
    )
}

/** One-line row text that takes the space left over in its row. */
@Composable
private fun RowScope.Line(text: String) {
    Text(
        text,
        style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 14.sp),
        maxLines = 1,
        modifier = GlanceModifier.defaultWeight(),
    )
}

@Composable
private fun Pill(text: String) {
    Text(
        text,
        style = TextStyle(color = GlanceTheme.colors.onSecondaryContainer, fontSize = 11.sp, fontWeight = FontWeight.Medium),
        maxLines = 1,
        modifier = GlanceModifier
            .background(GlanceTheme.colors.secondaryContainer)
            .cornerRadius(10.dp)
            .padding(horizontal = 8.dp, vertical = 2.dp),
    )
}

@Composable
private fun Muted(text: String) {
    Text(text, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 13.sp))
}
