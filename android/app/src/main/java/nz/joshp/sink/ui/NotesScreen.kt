package nz.joshp.sink.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.staggeredgrid.LazyVerticalStaggeredGrid
import androidx.compose.foundation.lazy.staggeredgrid.StaggeredGridCells
import androidx.compose.foundation.lazy.staggeredgrid.StaggeredGridItemSpan
import androidx.compose.foundation.lazy.staggeredgrid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.outlined.CheckBox
import androidx.compose.material.icons.outlined.CheckBoxOutlineBlank
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Draw
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import nz.joshp.sink.data.NoteMeta
import java.text.DateFormat
import java.util.Date

/** Keep's palette, same hues as the web's --note-* so a note looks the same everywhere. */
val NOTE_HUES = mapOf(
    "red" to Color(0xFFE8584D),
    "orange" to Color(0xFFEF8A3C),
    "yellow" to Color(0xFFF2C418),
    "green" to Color(0xFF6DBB4A),
    "teal" to Color(0xFF22A39A),
    "blue" to Color(0xFF4F8FD6),
    "purple" to Color(0xFF9A6AD1),
    "pink" to Color(0xFFE06AA6),
    "brown" to Color(0xFFA5774F),
    "gray" to Color(0xFF8A8A94),
)

/** A note's background: its colour mixed into the surface, so it works in light and dark. */
@Composable
fun noteTint(color: String?, base: Color = MaterialTheme.colorScheme.surfaceContainerLow, amount: Float = 0.22f): Color =
    NOTE_HUES[color]?.let { lerp(base, it, amount) } ?: base

@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun NotesScreen(vm: NotesViewModel, onOpen: (String) -> Unit, onNew: () -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { vm.refresh() }

    val inFolder = { n: NoteMeta -> state.folder.isEmpty() || n.path.startsWith(state.folder + "/") }
    val list = (state.results ?: state.notes).filter(inFolder)
    val searching = state.results != null
    val pinned = if (searching) emptyList() else list.filter { it.pinned }
    val others = if (searching) list else list.filterNot { it.pinned }
    val folders = remember(state.folders) { state.folders.map { it.substringBefore('/') }.distinct().filter { it != "attachments" } }

    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceContainerLowest)) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            ScreenTitle(
                state.folder.ifEmpty { "Notes" },
                trailing = {
                    if (state.offline) Icon(Icons.Outlined.CloudOff, "Offline", Modifier.padding(12.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                },
            )
            TextField(
                value = state.query,
                onValueChange = vm::setQuery,
                placeholder = { Text("Search notes") },
                leadingIcon = { Icon(Icons.Outlined.Search, null) },
                trailingIcon = { if (state.query.isNotEmpty()) IconButton(onClick = { vm.setQuery("") }) { Icon(Icons.Outlined.Close, "Clear") } },
                singleLine = true,
                shape = CircleShape,
                colors = TextFieldDefaults.colors(
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                    focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                ),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            )
            if (folders.isNotEmpty()) {
                LazyRow(
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(folders, key = { it }) { f ->
                        FilterChip(
                            selected = state.folder == f,
                            onClick = { vm.setFolder(f) },
                            label = { Text(f) },
                            leadingIcon = { Icon(Icons.Outlined.Folder, null, Modifier.size(FilterChipDefaults.IconSize)) },
                        )
                    }
                }
            } else {
                Spacer(Modifier.size(10.dp))
            }

            PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = { vm.refresh(pull = true) }, modifier = Modifier.fillMaxSize()) {
                when {
                    !state.loaded -> Box(Modifier.fillMaxSize(), Alignment.Center) { LoadingIndicator() }
                    list.isEmpty() && state.error != null && state.notes.isEmpty() -> EmptyState("Can't reach your notes", state.error ?: "")
                    list.isEmpty() -> EmptyState(
                        if (state.query.isNotBlank()) "Nothing matches" else "No notes yet",
                        if (state.query.isNotBlank()) "No notes mention “${state.query}”." else "Tap the pencil to write one. It's saved as a markdown file on the NAS.",
                    )
                    else -> LazyVerticalStaggeredGrid(
                        columns = StaggeredGridCells.Adaptive(160.dp),
                        contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 2.dp, bottom = 104.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalItemSpacing = 10.dp,
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        if (pinned.isNotEmpty()) {
                            item(key = "pinned-head", span = StaggeredGridItemSpan.FullLine) { SectionLabel("Pinned", Modifier.padding(start = 6.dp, top = 4.dp)) }
                            items(pinned, key = { "p:" + it.path }) { NoteCard(it, onOpen) }
                            if (others.isNotEmpty()) {
                                item(key = "others-head", span = StaggeredGridItemSpan.FullLine) { SectionLabel("Others", Modifier.padding(start = 6.dp, top = 8.dp)) }
                            }
                        }
                        items(others, key = { it.path }) { NoteCard(it, onOpen) }
                    }
                }
            }
        }

        FloatingActionButton(
            onClick = onNew,
            containerColor = MaterialTheme.colorScheme.primaryContainer,
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        ) { Icon(Icons.Outlined.Edit, "New note") }
    }
}

@Composable
private fun NoteCard(n: NoteMeta, onOpen: (String) -> Unit) {
    val firstLine = n.excerpt.orEmpty().trimStart().lineSequence().firstOrNull().orEmpty()
    // A note with no heading is named after its first line (Keep-style); showing both would repeat it.
    val showTitle = n.isBoard || n.snippet != null || n.title != n.fileName || !firstLine.startsWith(n.title)
    val outline = NOTE_HUES[n.color]?.copy(alpha = 0.45f) ?: MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(noteTint(n.color))
            .border(1.dp, outline, RoundedCornerShape(16.dp))
            .clickable { onOpen(n.path) }
            .padding(start = 14.dp, end = 12.dp, top = 12.dp, bottom = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (showTitle || n.pinned) {
            Row(verticalAlignment = Alignment.Top) {
                if (n.isBoard) {
                    Icon(Icons.Outlined.Draw, null, Modifier.size(18.dp).padding(top = 2.dp))
                    Spacer(Modifier.width(6.dp))
                }
                Text(
                    if (showTitle) n.title else "",
                    style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold),
                    modifier = Modifier.weight(1f),
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
                if (n.pinned) Icon(Icons.Filled.PushPin, "Pinned", Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (n.snippet != null) {
            Text(highlight(n.snippet), style = MaterialTheme.typography.bodyMedium, maxLines = 6, overflow = TextOverflow.Ellipsis)
        } else if (!n.isBoard) {
            Excerpt(n.excerpt.orEmpty())
        }
        // The time always fits; folder and tags take what's left.
        Row(verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (n.folder.isNotEmpty()) Pill(n.folder)
                n.tags.take(2).forEach { Pill("#$it") }
            }
            Spacer(Modifier.width(6.dp))
            Text(relativeTime(n.mtime), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        }
    }
}

@Composable
private fun Pill(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.07f))
            .padding(horizontal = 7.dp, vertical = 2.dp)
            .widthIn(max = 90.dp),
    )
}

private val TASK = Regex("""^\s*[-*+]\s+\[(.)]\s+(.*)$""")

/** Markdown excerpt as card text: checkboxes as boxes, markup stripped, a few lines. Mirrors the web card. */
@Composable
private fun Excerpt(text: String) {
    val lines = remember(text) { text.lines().filter { it.isNotBlank() && !it.startsWith("%%") }.take(10) }
    if (lines.isEmpty()) return
    Column(Modifier.heightIn(max = 220.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        for (l in lines) {
            val task = TASK.find(l)
            if (task != null) {
                val done = task.groupValues[1] != " "
                Row(verticalAlignment = Alignment.Top) {
                    Icon(
                        if (done) Icons.Outlined.CheckBox else Icons.Outlined.CheckBoxOutlineBlank,
                        null,
                        Modifier.size(17.dp).padding(top = 1.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        clean(task.groupValues[2]),
                        style = MaterialTheme.typography.bodyMedium.copy(textDecoration = if (done) TextDecoration.LineThrough else null),
                        color = if (done) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                    )
                }
            } else {
                Text(clean(l), style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

private fun clean(s: String) = s
    .replace(Regex("""!\[\[[^\]]*]]|!\[[^\]]*]\([^)]*\)"""), "🖼")
    .replace(Regex("""\[\[([^\]|]+)\|?([^\]]*)]]""")) { it.groupValues[2].ifEmpty { it.groupValues[1] } }
    .replace(Regex("""\[([^\]]+)]\([^)]*\)"""), "$1")
    .replace(Regex("""[📅⏳🛫✅]\s*\d{4}-\d{2}-\d{2}|\(@[^)]*\)"""), "")
    .replace(Regex("""^#+\s+"""), "")
    .replace(Regex("""^\s*[-*+]\s+"""), "• ")
    .replace(Regex("""^>\s?"""), "")
    .replace(Regex("""[*_~`]"""), "")
    .trim()

@Composable
private fun highlight(snippet: String): AnnotatedString {
    val mark = SpanStyle(background = MaterialTheme.colorScheme.primary.copy(alpha = 0.22f), fontWeight = FontWeight.SemiBold)
    return buildAnnotatedString {
        var rest = snippet
        while (true) {
            val m = Regex("""\[([^\]]+)]""").find(rest) ?: break
            append(rest.substring(0, m.range.first))
            withStyle(mark) { append(m.groupValues[1]) }
            rest = rest.substring(m.range.last + 1)
        }
        append(rest)
    }
}

fun relativeTime(ms: Long): String {
    val mins = (System.currentTimeMillis() - ms) / 60_000
    return when {
        mins < 1 -> "just now"
        mins < 60 -> "$mins min ago"
        mins < 24 * 60 && android.text.format.DateUtils.isToday(ms) -> DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(ms))
        else -> DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(ms))
    }
}
