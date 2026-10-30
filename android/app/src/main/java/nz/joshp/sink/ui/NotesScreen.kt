package nz.joshp.sink.ui

import androidx.activity.compose.BackHandler
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
import androidx.compose.material.icons.automirrored.outlined.DriveFileMove
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.CreateNewFolder
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.DriveFileRenameOutline
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Draw
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import nz.joshp.sink.data.NoteMeta
import kotlinx.coroutines.launch
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
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
    var naming by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var moving by remember { mutableStateOf(false) }
    // Runs a folder action and shows its error, if any.
    fun act(block: suspend () -> String?) {
        scope.launch { block()?.let { snackbar.showSnackbar(it) } }
    }
    // A note just deleted from its screen: offer Undo here, once.
    LaunchedEffect(Unit) {
        vm.trashed.collect { t ->
            if (t == null) return@collect
            vm.trashed.value = null
            val result = snackbar.showSnackbar("Deleted “${t.title}”", actionLabel = "Undo", duration = SnackbarDuration.Long)
            if (result == SnackbarResult.ActionPerformed) vm.undoTrash(t)?.let { snackbar.showSnackbar(it) }
        }
    }

    val hideFoldered by vm.hideFoldered.collectAsStateWithLifecycle()
    // Search always covers everything; home can leave filed notes to their folders (Settings).
    // Search covers everything; browsing can leave filed notes to their own folders (home and every folder alike).
    val inFolder = { n: NoteMeta ->
        when {
            state.results != null || !hideFoldered -> state.folder.isEmpty() || n.path.startsWith(state.folder + "/")
            else -> n.path.substringBeforeLast('/', "") == state.folder
        }
    }
    val list = (state.results ?: state.notes).filter(inFolder)
    val searching = state.results != null
    val pinned = if (searching) emptyList() else list.filter { it.pinned }
    val others = if (searching) list else list.filterNot { it.pinned }
    val inside = state.folder.isNotEmpty()
    // Subfolders right here, unless searching (results span every folder).
    val subfolders = remember(state.folders, state.folder) { childFolders(state.folders, state.folder) }
    // Home's Recent row (not in folders or search).
    val opened by vm.opened.collectAsStateWithLifecycle()
    val recent = remember(state.notes, opened) { recentNotes(state.notes, opened) }
    // Once there are enough notes for it to save scrolling, or whenever home leaves some out (filed in folders).
    val showRecent = !inside && !searching && (state.notes.size > 6 || (hideFoldered && state.notes.any { '/' in it.path }))
    var recentShut by rememberSaveable { mutableStateOf(false) }
    // Back climbs out of a folder before it leaves the tab.
    BackHandler(enabled = inside) { vm.folderUp() }

    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceContainerLowest)) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            ScreenTitle(
                state.folder.substringAfterLast('/').ifEmpty { "Notes" },
                onBack = if (inside) ({ vm.folderUp(); Unit }) else null,
                trailing = {
                    if (state.offline) Icon(Icons.Outlined.CloudOff, "Offline", Modifier.padding(12.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Box {
                        IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, "Folder actions") }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(
                                text = { Text(if (inside) "New folder here" else "New folder") },
                                leadingIcon = { Icon(Icons.Outlined.CreateNewFolder, null) },
                                onClick = { menu = false; naming = true },
                            )
                            if (inside) {
                                DropdownMenuItem(
                                    text = { Text("Rename folder") },
                                    leadingIcon = { Icon(Icons.Outlined.DriveFileRenameOutline, null) },
                                    onClick = { menu = false; renaming = true },
                                )
                                DropdownMenuItem(
                                    text = { Text("Move folder to…") },
                                    leadingIcon = { Icon(Icons.AutoMirrored.Outlined.DriveFileMove, null) },
                                    onClick = { menu = false; moving = true },
                                )
                                DropdownMenuItem(
                                    text = { Text("Delete folder") },
                                    leadingIcon = { Icon(Icons.Outlined.Delete, null) },
                                    // No "are you sure?": the snackbar's Undo puts the whole folder back.
                                    onClick = { menu = false; act { vm.trashFolder(state.folder) } },
                                )
                            }
                        }
                    }
                },
            )
            if (inside) FolderCrumbs(state.folder, onOpen = vm::setFolder, modifier = Modifier.padding(start = 14.dp, end = 16.dp, bottom = 8.dp))
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
            if (subfolders.isNotEmpty() && !searching) {
                LazyRow(
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(subfolders, key = { it }) { f ->
                        FolderTile(f.substringAfterLast('/'), countIn(state.notes, f)) { vm.setFolder(f) }
                    }
                }
            } else {
                Spacer(Modifier.size(10.dp))
            }

            PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = { vm.refresh(pull = true) }, modifier = Modifier.fillMaxSize()) {
                when {
                    !state.loaded -> Box(Modifier.fillMaxSize(), Alignment.Center) { LoadingIndicator() }
                    list.isEmpty() && state.error != null && state.notes.isEmpty() -> EmptyState("Can't reach your notes", state.error ?: "")
                    list.isEmpty() && !showRecent -> EmptyState(
                        when {
                            state.query.isNotBlank() -> "Nothing matches"
                            inside -> "Nothing in here yet"
                            else -> "No notes yet"
                        },
                        when {
                            state.query.isNotBlank() -> "No notes mention “${state.query}”."
                            inside -> "Tap the pencil to write a note in this folder."
                            else -> "Tap the pencil to write one. It's saved as a markdown file on your server."
                        },
                    )
                    else -> LazyVerticalStaggeredGrid(
                        columns = StaggeredGridCells.Adaptive(160.dp),
                        contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 2.dp, bottom = 104.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalItemSpacing = 10.dp,
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        if (showRecent) {
                            item(key = "recent", span = StaggeredGridItemSpan.FullLine) {
                                RecentStrip(recent, recentShut, onToggle = { recentShut = !recentShut }, onOpen = onOpen)
                            }
                            // Home with everything filed away: say where the notes are.
                            if (list.isEmpty()) item(key = "filed", span = StaggeredGridItemSpan.FullLine) {
                                Text(
                                    "Everything's filed away in folders. New notes you take here stay on this page.",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 16.dp),
                                )
                            }
                        }
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

        NewMenuFab(vm, state.folder, snackbar, onNewNote = onNew, onOpen = onOpen, modifier = Modifier.align(Alignment.BottomEnd).padding(bottom = 8.dp))
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(bottom = 80.dp))
    }

    if (naming) {
        NameDialog(
            title = if (inside) "New folder in ${state.folder.substringAfterLast('/')}" else "New folder",
            initial = "",
            confirm = "Create",
            onConfirm = { name -> naming = false; act { vm.newFolder(state.folder, name) } },
            onDismiss = { naming = false },
        )
    }
    if (renaming) {
        NameDialog(
            title = "Rename folder",
            initial = state.folder.substringAfterLast('/'),
            confirm = "Rename",
            onConfirm = { name -> renaming = false; act { vm.renameFolder(state.folder, name) } },
            onDismiss = { renaming = false },
        )
    }
    if (moving) {
        val from = state.folder
        FolderPickerSheet(
            title = "Move “${from.substringAfterLast('/')}” to",
            folders = state.folders,
            current = from.substringBeforeLast('/', ""),
            exclude = from,
            onPick = { parent -> moving = false; act { vm.moveFolder(from, parent) } },
            onNewFolder = { path ->
                val (made, error) = vm.createFolderAt(path)
                error?.let { snackbar.showSnackbar(it) }
                made
            },
            onDismiss = { moving = false },
        )
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

private val TASK = Regex("""^[-*+]\s+\[(.)]\s+(.*)$""")
private val HEADING = Regex("""^(#{1,6})\s+(.*)$""")
private val QUOTE = Regex("""^>\s?(.*)$""")
private val BULLET = Regex("""^[-*+]\s+(.*)$""")
private val NUMBERED = Regex("""^(\d+[.)])\s+(.*)$""")
private val RULE = Regex("""^\s*([-*_])(\s*\1){2,}\s*$""")
private val TABLE_ROW = Regex("""^\|.*\|\s*$""")
private val TABLE_RULE = Regex("""^\|[\s:|-]+\|\s*$""")
private val FENCE = Regex("""^\s*(```|~~~)""")

/** One line of a card: what kind it is, how deep it's nested, and its text (marker removed). */
private sealed interface CardLine {
    val depth: Int
    data class Plain(val text: String, override val depth: Int) : CardLine
    data class Item(val marker: String, val text: String, override val depth: Int) : CardLine
    data class Task(val done: Boolean, val text: String, override val depth: Int) : CardLine
    data class Heading(val level: Int, val text: String) : CardLine { override val depth = 0 }
    data class Quote(val text: String, override val depth: Int) : CardLine
    data class Code(val text: String) : CardLine { override val depth = 0 }
    data class Row(val cells: List<String>) : CardLine { override val depth = 0 }
}

/** A note's first lines, read the way the web card reads them. */
private fun cardLines(text: String): List<CardLine> {
    val out = mutableListOf<CardLine>()
    var fenced = false
    for (raw in text.lines()) {
        if (out.size == 10) break
        if (FENCE.containsMatchIn(raw)) { fenced = !fenced; continue }
        if (fenced) { if (raw.isNotBlank()) out += CardLine.Code(raw); continue }
        if (raw.isBlank() || raw.startsWith("%%") || RULE.matches(raw)) continue
        // Tabs, or every two spaces, are one level of nesting.
        val lead = raw.takeWhile { it == ' ' || it == '\t' }
        val depth = (lead.fold(0) { d, c -> d + if (c == '\t') 2 else 1 } / 2).coerceAtMost(4)
        val l = raw.substring(lead.length)
        // Table rows as their cells; the |---| line under the header is dropped.
        if (TABLE_ROW.matches(l)) {
            if (!TABLE_RULE.matches(l)) out += CardLine.Row(l.trim().removePrefix("|").removeSuffix("|").split(Regex("""(?<!\\)\|""")).map { it.trim().replace("\\|", "|") })
            continue
        }
        TASK.find(l)?.let { out += CardLine.Task(it.groupValues[1] != " ", it.groupValues[2], depth); continue }
        HEADING.find(l)?.let { out += CardLine.Heading(it.groupValues[1].length, it.groupValues[2]); continue }
        QUOTE.find(l)?.let { m ->
            // Callout header `[!tip] Title` reads as just the title (or the type when there isn't one).
            val body = m.groupValues[1].replace(Regex("""^\[!(\w+)][+-]?\s*(.*)$""")) { c ->
                c.groupValues[2].ifEmpty { c.groupValues[1].replaceFirstChar(Char::uppercase) }
            }
            if (body.isNotBlank()) out += CardLine.Quote(body, depth)
            continue
        }
        BULLET.find(l)?.let { out += CardLine.Item("•", it.groupValues[1], depth); continue }
        NUMBERED.find(l)?.let { out += CardLine.Item(it.groupValues[1], it.groupValues[2], depth); continue }
        out += CardLine.Plain(l, depth)
    }
    return out
}

/** Markdown excerpt as card text, formatted like the note: headings, nesting, checkboxes, quotes, code, bold/italic. */
@Composable
fun Excerpt(text: String, small: Boolean = false) {
    val lines = remember(text) { cardLines(text) }
    if (lines.isEmpty()) return
    val style = if (small) MaterialTheme.typography.bodySmall else MaterialTheme.typography.bodyMedium
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val codeBg = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f)
    val markBg = MaterialTheme.colorScheme.primary.copy(alpha = 0.22f)
    val oneLine = if (small) 1 else Int.MAX_VALUE
    fun inline(s: String) = inlineMarkdown(s, codeBg, markBg)
    Column(Modifier.heightIn(max = 220.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        for (line in lines) {
            val indent = Modifier.padding(start = (line.depth * 14).dp)
            when (line) {
                is CardLine.Task -> Row(indent, verticalAlignment = Alignment.Top) {
                    Icon(
                        if (line.done) Icons.Outlined.CheckBox else Icons.Outlined.CheckBoxOutlineBlank,
                        null,
                        Modifier.size(if (small) 14.dp else 17.dp).padding(top = 1.dp),
                        tint = muted,
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        inline(line.text),
                        style = style.copy(textDecoration = if (line.done) TextDecoration.LineThrough else null),
                        color = if (line.done) muted else MaterialTheme.colorScheme.onSurface,
                        maxLines = oneLine,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                is CardLine.Item -> Row(indent) {
                    Text(line.marker, style = style, color = muted)
                    Spacer(Modifier.width(6.dp))
                    Text(inline(line.text), style = style, maxLines = oneLine, overflow = TextOverflow.Ellipsis)
                }
                is CardLine.Heading -> Text(
                    inline(line.text),
                    style = style.copy(
                        fontWeight = FontWeight.Bold,
                        fontSize = if (small || line.level > 2) style.fontSize else style.fontSize * (if (line.level == 1) 1.15f else 1.07f),
                    ),
                    maxLines = oneLine,
                    overflow = TextOverflow.Ellipsis,
                )
                is CardLine.Quote -> Row(indent.height(IntrinsicSize.Min)) {
                    Box(Modifier.width(3.dp).fillMaxHeight().background(MaterialTheme.colorScheme.primary.copy(alpha = 0.45f), RoundedCornerShape(2.dp)))
                    Spacer(Modifier.width(8.dp))
                    Text(inline(line.text), style = style, color = muted, maxLines = oneLine, overflow = TextOverflow.Ellipsis)
                }
                is CardLine.Code -> Text(
                    line.text,
                    style = style.copy(fontFamily = FontFamily.Monospace, fontSize = style.fontSize * 0.9f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth().background(codeBg, RoundedCornerShape(4.dp)).padding(horizontal = 6.dp),
                )
                is CardLine.Row -> androidx.compose.foundation.layout.Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (c in line.cells) Text(inline(c), style = style, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                }
                is CardLine.Plain -> Text(inline(line.text), style = style, maxLines = oneLine, overflow = TextOverflow.Ellipsis, modifier = indent)
            }
        }
    }
}

private val INLINE = Regex(
    """`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|==([^=]+)==|(?<![*\w])\*([^*\s][^*]*)\*(?!\w)|(?<!\w)_([^_\s][^_]*)_(?!\w)""",
)

/** Inline markdown as styled text: links as their text, Tasks dates dropped, bold/italic/strike/code/highlight kept. */
private fun inlineMarkdown(s: String, codeBg: Color, markBg: Color): AnnotatedString {
    val plain = clean(s)
    return buildAnnotatedString {
        var at = 0
        for (m in INLINE.findAll(plain)) {
            append(plain.substring(at, m.range.first))
            val g = m.groupValues
            when {
                g[1].isNotEmpty() -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBg)) { append(g[1]) }
                g[2].isNotEmpty() || g[3].isNotEmpty() -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(g[2].ifEmpty { g[3] }) }
                g[4].isNotEmpty() -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append(g[4]) }
                g[5].isNotEmpty() -> withStyle(SpanStyle(background = markBg)) { append(g[5]) }
                else -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(g[6].ifEmpty { g[7] }) }
            }
            at = m.range.last + 1
        }
        append(plain.substring(at))
    }
}

/** Links and embeds as their text, Tasks dates and reminders dropped. Formatting marks stay for [inlineMarkdown]. */
private fun clean(s: String) = s
    .replace(Regex("""!\[\[[^\]]*]]|!\[[^\]]*]\([^)]*\)"""), "🖼")
    .replace(Regex("""\[\[([^\]|]+)\|?([^\]]*)]]""")) { it.groupValues[2].ifEmpty { it.groupValues[1] } }
    .replace(Regex("""\[([^\]]+)]\([^)]*\)"""), "$1")
    .replace(Regex("""[📅⏳🛫✅]\s*\d{4}-\d{2}-\d{2}|\(@[^)]*\)"""), "")
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
