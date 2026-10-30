package nz.joshp.sink.data

import java.time.LocalDateTime
import java.time.format.TextStyle
import java.util.Locale

// Templates: notes in a Templates folder (Obsidian's default), used to start a note (New > From template) or dropped
// into one (/template). Mirrors web/src/templates.js: {{title}}, {{date}}, {{time}} and {{date:FORMAT}} (YYYY, M, MM,
// MMM, MMMM, D, DD, ddd, dddd, H, HH, mm) are filled in as in Obsidian's core Templates plugin.

/** Template notes, by name (anything in a top-level Templates folder). */
fun templatesIn(notes: List<NoteMeta>): List<NoteMeta> =
    notes
        .filter { it.path.startsWith("templates/", ignoreCase = true) && !it.isBoard }
        .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.path })

private val TOKENS = Regex("YYYY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|mm")
private val VARIABLE = Regex("""\{\{\s*(title|date|time)(?::([^}]*))?\s*\}\}""")
private val FRONTMATTER = Regex("""^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n""")

private fun format(d: LocalDateTime, fmt: String): String {
    val locale = Locale.getDefault()
    val pad = { n: Int -> n.toString().padStart(2, '0') }
    return TOKENS.replace(fmt) {
        when (it.value) {
            "YYYY" -> d.year.toString()
            "MMMM" -> d.month.getDisplayName(TextStyle.FULL, locale)
            "MMM" -> d.month.getDisplayName(TextStyle.SHORT, locale)
            "MM" -> pad(d.monthValue)
            "M" -> d.monthValue.toString()
            "DD" -> pad(d.dayOfMonth)
            "D" -> d.dayOfMonth.toString()
            "dddd" -> d.dayOfWeek.getDisplayName(TextStyle.FULL, locale)
            "ddd" -> d.dayOfWeek.getDisplayName(TextStyle.SHORT, locale)
            "HH" -> pad(d.hour)
            "H" -> d.hour.toString()
            else -> pad(d.minute)
        }
    }
}

/**
 * A template's text with its {{variables}} filled in. [inline] (dropped into the middle of a note) leaves its
 * frontmatter behind, where it would just be text.
 */
fun fillTemplate(text: String, title: String = "", inline: Boolean = false, now: LocalDateTime = LocalDateTime.now()): String {
    val body = if (inline) text.replaceFirst(FRONTMATTER, "") else text
    return VARIABLE.replace(body) { m ->
        val (key, fmt) = m.destructured
        when {
            key == "title" -> title
            fmt.isNotBlank() -> format(now, fmt.trim())
            key == "time" -> format(now, "HH:mm")
            else -> format(now, "YYYY-MM-DD")
        }
    }
}
