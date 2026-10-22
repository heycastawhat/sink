package nz.joshp.sink.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Article
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.automirrored.outlined.ReceiptLong
import androidx.compose.material.icons.outlined.Alarm
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Category
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.outlined.Place
import androidx.compose.material.icons.outlined.Restaurant
import androidx.compose.material.icons.outlined.ShoppingBag
import androidx.compose.ui.graphics.vector.ImageVector
import java.text.DateFormat
import java.util.Calendar
import java.util.Date

data class Kind(val id: String, val label: String, val icon: ImageVector)

val KINDS = listOf(
    Kind("event", "Events", Icons.Outlined.Event),
    Kind("receipt", "Receipts", Icons.AutoMirrored.Outlined.ReceiptLong),
    Kind("product", "Products", Icons.Outlined.ShoppingBag),
    Kind("place", "Places", Icons.Outlined.Place),
    Kind("code", "Code", Icons.Outlined.Code),
    Kind("article", "Articles", Icons.AutoMirrored.Outlined.Article),
    Kind("message", "Messages", Icons.AutoMirrored.Outlined.Chat),
    Kind("recipe", "Recipes", Icons.Outlined.Restaurant),
    Kind("other", "Other", Icons.Outlined.Category),
)

fun kindOf(id: String?) = KINDS.firstOrNull { it.id == id }

fun actionIcon(type: String): ImageVector = when (type) {
    "calendar" -> Icons.Outlined.Event
    "reminder" -> Icons.Outlined.Alarm
    "todo" -> Icons.Outlined.CheckCircle
    "open_url" -> Icons.AutoMirrored.Outlined.OpenInNew
    "copy" -> Icons.Outlined.ContentCopy
    else -> Icons.Outlined.Bolt
}

fun relativeDay(ms: Long): String {
    val day = Calendar.getInstance().apply { timeInMillis = ms }
    val today = Calendar.getInstance()
    fun Calendar.dayNumber() = get(Calendar.YEAR) * 400 + get(Calendar.DAY_OF_YEAR)
    val diff = today.dayNumber() - day.dayNumber()
    return when {
        diff == 0 -> "Today"
        diff == 1 -> "Yesterday"
        diff in 2..6 -> day.getDisplayName(Calendar.DAY_OF_WEEK, Calendar.LONG, java.util.Locale.getDefault()) ?: ""
        else -> DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(ms))
    }
}

fun timeOf(ms: Long): String = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(ms))
