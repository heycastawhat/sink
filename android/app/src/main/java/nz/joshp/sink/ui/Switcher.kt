package nz.joshp.sink.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.NoteAdd
import androidx.compose.material.icons.automirrored.outlined.StickyNote2
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Draw
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import nz.joshp.sink.data.NoteMeta

/**
 * How well [q] (lower case) matches a note, or 0: the title starting with it beats a word in it starting with it,
 * beats it anywhere in the title or path, beats its letters in order (so "mtg nts" finds "Meeting notes").
 * Same as web/src/notes.js matchScore.
 */
private fun matchScore(q: String, n: NoteMeta): Int {
    val title = n.title.lowercase()
    val path = n.path.lowercase()
    if (title.startsWith(q)) return 100
    if (Regex("(^|[\\s/_-])" + Regex.escape(q)).containsMatchIn(title)) return 80
    if (q in title) return 60
    if (q in path) return 40
    val letters = q.filterNot { it.isWhitespace() }
    var i = 0
    for (ch in title) if (i < letters.length && ch == letters[i]) i++
    return if (i == letters.length) 20 else 0
}

/**
 * The quick switcher (the web's Cmd/Ctrl+K): jump to any note by typing part of its name, most recently used first.
 * With no match, the keyboard's Go makes a new note with that name instead ([onCreate]).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QuickSwitcherSheet(
    notes: List<NoteMeta>,
    opened: Map<String, Long>,
    onOpen: (String) -> Unit,
    onCreate: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var query by remember { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    val recency = { n: NoteMeta -> maxOf(opened[n.path] ?: 0L, n.mtime) }
    val q = query.trim().lowercase()
    val items = remember(notes, opened, q) {
        if (q.isEmpty()) notes.sortedByDescending(recency).take(12)
        else notes.map { it to matchScore(q, it) }
            .filter { it.second > 0 }
            .sortedWith(compareByDescending<Pair<NoteMeta, Int>> { it.second }.thenByDescending { recency(it.first) })
            .take(30)
            .map { it.first }
    }
    LaunchedEffect(Unit) { focus.requestFocus() }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(bottom = 12.dp)) {
            TextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text("Find a note") },
                leadingIcon = { Icon(Icons.Outlined.Search, null) },
                singleLine = true,
                shape = CircleShape,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = {
                    val first = items.firstOrNull()
                    if (first != null) onOpen(first.path) else if (query.isNotBlank()) onCreate(query.trim())
                }),
                colors = TextFieldDefaults.colors(
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                    focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
                    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                ),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).focusRequester(focus),
            )
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 420.dp).padding(top = 8.dp)) {
                items(items, key = { it.path }) { n ->
                    PickerRow(
                        if (n.isBoard) Icons.Outlined.Draw else Icons.AutoMirrored.Outlined.StickyNote2,
                        n.title,
                        n.folder.ifEmpty { null },
                    ) { onOpen(n.path) }
                }
                // Typing a name that isn't there yet: offer to make it (Shift+Enter on the web).
                if (query.isNotBlank() && items.none { it.title.equals(query.trim(), ignoreCase = true) }) {
                    item(key = "new") { PickerRow(Icons.AutoMirrored.Outlined.NoteAdd, "New note “${query.trim()}”", null) { onCreate(query.trim()) } }
                }
            }
        }
    }
}

/** New > From template, and /template in a note: which template. Notes in a Templates folder are the templates. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TemplatePickerSheet(templates: List<NoteMeta>, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 12.dp)) {
            Text(
                "Templates",
                style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold),
                modifier = Modifier.padding(start = 24.dp, end = 24.dp, bottom = 8.dp),
            )
            if (templates.isEmpty()) {
                Text(
                    "Put notes in a folder called Templates to use them here. {{title}}, {{date}} and {{time}} get filled in.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(24.dp),
                )
            } else LazyColumn(Modifier.fillMaxWidth().heightIn(max = 460.dp)) {
                items(templates, key = { it.path }) { n ->
                    val detail = n.excerpt.orEmpty().lineSequence().firstOrNull { it.isNotBlank() }
                    PickerRow(Icons.Outlined.ContentCopy, n.title, detail) { onPick(n.path) }
                }
            }
        }
    }
}

@Composable
private fun PickerRow(icon: ImageVector, title: String, detail: String?, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 24.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(icon, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium), maxLines = 1, overflow = TextOverflow.Ellipsis)
            detail?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}
