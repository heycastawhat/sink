package nz.joshp.sink.ui

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.CalendarContract
import android.widget.Toast
import nz.joshp.sink.data.Action
import nz.joshp.sink.data.str
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.LocalDateTime

/** Turns an AI-suggested action into the matching Android intent. Returns false if nothing could handle it. */
fun runAction(context: Context, action: Action): Boolean {
    val p = action.payload
    val intent: Intent = when (action.type) {
        "calendar" -> calendarIntent(p.str("title") ?: action.label, p.str("start"), p.str("end"), p.str("location"))
        // No standard reminders intent; a calendar entry at the due time is the closest universal thing.
        "reminder" -> calendarIntent(p.str("text") ?: action.label, p.str("due"), null, null)
        "todo" -> Intent.createChooser(
            Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, p.str("text") ?: action.label),
            "Add to…",
        )
        "open_url" -> {
            val url = p.str("url") ?: return false
            if (!url.startsWith("http://") && !url.startsWith("https://")) return false
            Intent(Intent.ACTION_VIEW, Uri.parse(url))
        }
        "copy" -> {
            val cm = context.getSystemService(ClipboardManager::class.java)
            cm.setPrimaryClip(ClipData.newPlainText(action.label, p.str("text") ?: ""))
            return true
        }
        else -> return false
    }
    return try {
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
    } catch (e: ActivityNotFoundException) {
        Toast.makeText(context, "No app can do that", Toast.LENGTH_SHORT).show()
        false
    }
}

private fun calendarIntent(title: String, start: String?, end: String?, location: String?): Intent {
    val intent = Intent(Intent.ACTION_INSERT, CalendarContract.Events.CONTENT_URI)
        .putExtra(CalendarContract.Events.TITLE, title)
    location?.let { intent.putExtra(CalendarContract.Events.EVENT_LOCATION, it) }
    val begin = parseTime(start)
    if (begin != null) {
        intent.putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, begin.first)
        if (begin.second) {
            intent.putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, true)
        } else {
            val finish = parseTime(end)?.first ?: (begin.first + 60 * 60 * 1000)
            intent.putExtra(CalendarContract.EXTRA_EVENT_END_TIME, finish)
        }
    }
    return intent
}

/** Returns epoch millis and whether it was a date-only value. */
private fun parseTime(value: String?): Pair<Long, Boolean>? {
    if (value.isNullOrBlank()) return null
    val zone = ZoneId.systemDefault()
    return runCatching { OffsetDateTime.parse(value).toInstant().toEpochMilli() to false }.getOrNull()
        ?: runCatching { ZonedDateTime.parse(value).toInstant().toEpochMilli() to false }.getOrNull()
        ?: runCatching { LocalDateTime.parse(value).atZone(zone).toInstant().toEpochMilli() to false }.getOrNull()
        ?: runCatching { LocalDate.parse(value).atStartOfDay(zone).toInstant().toEpochMilli() to true }.getOrNull()
}
