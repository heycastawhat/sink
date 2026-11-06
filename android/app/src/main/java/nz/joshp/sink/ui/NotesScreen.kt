package nz.joshp.sink.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.ui.draw.shadow
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.staggeredgrid.LazyVerticalStaggeredGrid
import androidx.compose.foundation.lazy.staggeredgrid.StaggeredGridCells
import androidx.compose.foundation.lazy.staggeredgrid.StaggeredGridItemSpan
import androidx.compose.foundation.lazy.staggeredgrid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Unarchive
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import nz.joshp.sink.data.NOTE_COLORS
import androidx.compose.material.icons.outlined.Check
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
import androidx.compose.material.icons.outlined.FilterList
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberSwipeToDismissBoxState
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.foundation.Image
import androidx.compose.runtime.produceState
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
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
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.Density
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.material.icons.outlined.EditNote
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.SearchOff
import androidx.compose.material.icons.outlined.Settings
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
fun NotesScreen(vm: NotesViewModel, onOpen: (String) -> Unit, onNew: (text: String) -> Unit, onSettings: () -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { vm.refresh() }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
    var naming by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var moving by remember { mutableStateOf(false) }
    var filterMenu by remember { mutableStateOf(false) }
    var byTitle by rememberSaveable { mutableStateOf(false) }
    // The note whose card was long-pressed, for its quick actions; and that note, when moving it.
    var cardMenu by remember { mutableStateOf<NoteMeta?>(null) }
    var movingNote by remember { mutableStateOf<NoteMeta?>(null) }
    val pullUp = rememberPullUpToCreate { onNew("") }
    val haptics = rememberHaptics()
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

    val onCardMenu = { n: NoteMeta -> cardMenu = n }
    // Shared by the card menu and swiping a card. [n] may be stale, so read pinned fresh.
    fun togglePin(n: NoteMeta) {
        val on = !(state.notes.firstOrNull { it.path == n.path } ?: n).pinned
        haptics.toggle(on)
        act { vm.setCardMeta(n.path, pin = on) }
    }
    // Returns once the move is done (or failed); the Undo snackbar carries on in the screen's scope.
    suspend fun archive(n: NoteMeta) {
        haptics.confirm()
        val name = n.path.substringAfterLast('/')
        val archived = n.path.startsWith("Archive/", ignoreCase = true)
        val dest = if (archived) name else "Archive/$name"
        vm.moveCard(n.path, dest)?.let { scope.launch { snackbar.showSnackbar(it) }; return }
        scope.launch {
            val result = snackbar.showSnackbar(if (archived) "Unarchived" else "Archived", actionLabel = "Undo")
            if (result == SnackbarResult.ActionPerformed) vm.moveCard(dest, n.path)?.let { snackbar.showSnackbar(it) }
        }
    }

    val hideFoldered by vm.hideFoldered.collectAsStateWithLifecycle()
    // Search covers everything; browsing can leave filed notes to their own folders (home and every folder alike).
    val inFolder = { n: NoteMeta ->
        when {
            state.results != null || !hideFoldered -> state.folder.isEmpty() || n.path.startsWith(state.folder + "/")
            else -> n.path.substringBeforeLast('/', "") == state.folder
        }
    }
    val list = (state.results ?: state.notes).filter(inFolder)
    val searching = state.results != null
    // The server sends newest first; search keeps its own order (best match first).
    val ordered = if (byTitle && !searching) list.sortedBy { it.title.lowercase() } else list
    val pinned = if (searching) emptyList() else ordered.filter { it.pinned }
    val others = if (searching) ordered else ordered.filterNot { it.pinned }
    val inside = state.folder.isNotEmpty()
    // Subfolders right here, unless searching (results span every folder).
    val subfolders = remember(state.folders, state.folder) { childFolders(state.folders, state.folder) }
    val unfiledHome = hideFoldered && !inside && !searching
    val subtitle = when {
        !state.loaded -> null
        searching -> "${list.size} ${if (list.size == 1) "result" else "results"}"
        else -> listOfNotNull(
            if (unfiledHome) "${list.size} unfiled" else "${list.size} ${if (list.size == 1) "note" else "notes"}",
            subfolders.size.takeIf { it > 0 }?.let { "$it ${if (it == 1) "folder" else "folders"}" },
        ).joinToString(" · ")
    }
    // Home's Recent row (not in folders or search).
    val opened by vm.opened.collectAsStateWithLifecycle()
    // With filed notes kept off home, the row is just the ones in folders (the rest are already on the page).
    val recent = remember(state.notes, opened, hideFoldered) {
        recentNotes(if (hideFoldered) state.notes.filter { '/' in it.path } else state.notes, opened, count = if (hideFoldered) 6 else 8)
    }
    // Once there are enough notes for it to save scrolling, or whenever home leaves some out (filed in folders).
    val showRecent = !inside && !searching && (if (hideFoldered) recent.isNotEmpty() else state.notes.size > 6)
    var recentShut by rememberSaveable { mutableStateOf(false) }
    var searchShown by remember { mutableStateOf(true) }
    var searchFocused by remember { mutableStateOf(false) }
    // The list runs bottom up: a finger moving down shows older notes (search goes), moving up comes back (search returns).
    val searchHider = remember {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (source == NestedScrollSource.UserInput && kotlin.math.abs(available.y) > 4f) searchShown = available.y < 0f
                return Offset.Zero
            }
        }
    }
    // Back climbs out of a folder before it leaves the tab.
    BackHandler(enabled = inside) { vm.folderUp() }

    // Pulling up for a new note works from the search field and toolbar area too, not just the list.
    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceContainerLowest).pullUpFromAnywhere(pullUp)) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            ScreenTitle(
                state.folder.substringAfterLast('/').ifEmpty { "Notes" },
                sub = subtitle,
                onBack = if (inside) ({ vm.folderUp(); Unit }) else null,
                trailing = {
                    if (state.offline) Icon(Icons.Outlined.CloudOff, "Offline", Modifier.padding(12.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Box {
                        IconButton(onClick = { haptics.tick(); menu = true }) { Icon(Icons.Outlined.MoreVert, "More") }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(
                                text = { Text(if (inside) "New folder here" else "New folder") },
                                leadingIcon = { Icon(Icons.Outlined.CreateNewFolder, null) },
                                onClick = { menu = false; haptics.tick(); naming = true },
                            )
                            if (inside) {
                                DropdownMenuItem(
                                    text = { Text("Rename folder") },
                                    leadingIcon = { Icon(Icons.Outlined.DriveFileRenameOutline, null) },
                                    onClick = { menu = false; haptics.tick(); renaming = true },
                                )
                                DropdownMenuItem(
                                    text = { Text("Move folder to…") },
                                    leadingIcon = { Icon(Icons.AutoMirrored.Outlined.DriveFileMove, null) },
                                    onClick = { menu = false; haptics.tick(); moving = true },
                                )
                                DropdownMenuItem(
                                    text = { Text("Delete folder") },
                                    leadingIcon = { Icon(Icons.Outlined.Delete, null) },
                                    // No "are you sure?": the snackbar's Undo puts the whole folder back.
                                    onClick = { menu = false; haptics.reject(); act { vm.trashFolder(state.folder) } },
                                )
                            }
                            HorizontalDivider()
                            DropdownMenuItem(
                                text = { Text("Settings") },
                                leadingIcon = { Icon(Icons.Outlined.Settings, null) },
                                onClick = { menu = false; haptics.tick(); onSettings() },
                            )
                        }
                    }
                },
            )
            if (inside) FolderCrumbs(state.folder, onOpen = vm::setFolder, modifier = Modifier.padding(start = 14.dp, end = 16.dp, bottom = 8.dp))

            PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = { vm.refresh(pull = true) }, modifier = Modifier.fillMaxSize()) {
                when {
                    !state.loaded -> Box(Modifier.fillMaxSize(), Alignment.Center) { LoadingIndicator() }
                    list.isEmpty() && state.error != null && state.notes.isEmpty() -> EmptyState("Can't reach your notes", state.error ?: "", Icons.Outlined.CloudOff)
                    list.isEmpty() && !showRecent && (subfolders.isEmpty() || searching) -> EmptyState(
                        when {
                            state.query.isNotBlank() -> "Nothing matches"
                            inside -> "Nothing in here yet"
                            else -> "No notes yet"
                        },
                        when {
                            state.query.isNotBlank() -> "No notes mention “${state.query}”."
                            inside -> "Tap + or pull up to write a note in this folder."
                            else -> "Tap + or pull up to write one. It's saved as a markdown file on your server."
                        },
                        when {
                            state.query.isNotBlank() -> Icons.Outlined.SearchOff
                            inside -> Icons.Outlined.FolderOpen
                            else -> Icons.Outlined.EditNote
                        },
                    )
                    // Laid out from the bottom up, where a thumb reaches: folders, then Recent, pinned notes, and the
                    // newest notes, with older ones further up (scroll up for them). Each section's label comes after
                    // its items here, which puts it above them on screen.
                    else -> LazyVerticalStaggeredGrid(
                        columns = CardColumns,
                        reverseLayout = true,
                        contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 8.dp, bottom = toolbarClearance(extra = 68.dp)),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalItemSpacing = 10.dp,
                        modifier = Modifier.fillMaxSize().pullUpToCreate(pullUp).nestedScroll(searchHider),
                    ) {
                        // Folders sit as chips in a row; with none yet, home still offers "New folder".
                        if (!searching && (subfolders.isNotEmpty() || !inside)) {
                            item(key = "folders", span = StaggeredGridItemSpan.FullLine) {
                                FolderChips(subfolders, { countIn(state.notes, it) }, onOpen = { haptics.tick(); vm.setFolder(it) }, onNew = { haptics.tick(); naming = true })
                            }
                            item(key = "folders-head", span = StaggeredGridItemSpan.FullLine) { SectionLabel("Folders", Modifier.animateItem().padding(start = 6.dp, top = 8.dp)) }
                        }
                        if (showRecent) {
                            if (hideFoldered) {
                                item(key = "recent", span = StaggeredGridItemSpan.FullLine) { RecentFiledRow(recent, onOpen) }
                                item(key = "recent-head", span = StaggeredGridItemSpan.FullLine) { SectionLabel("Recent in folders", Modifier.animateItem().padding(start = 6.dp, top = 8.dp)) }
                            } else item(key = "recent", span = StaggeredGridItemSpan.FullLine) {
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
                        // Swipe a card one way to pin it, the other to archive it. Pinned and other cards share keys
                        // (a note is only ever in one), so a pinned card slides between the sections.
                        val card: @Composable (NoteMeta, Modifier) -> Unit = { n, modifier ->
                            SwipeCard(n, onPin = { togglePin(n) }, onArchive = { archive(n) }, modifier) {
                                NoteCard(n, onOpen, onCardMenu, vm::cardImage)
                            }
                        }
                        if (pinned.isNotEmpty()) {
                            items(pinned, key = { it.path }) { card(it, Modifier.animateItem()) }
                            item(key = "pinned-head", span = StaggeredGridItemSpan.FullLine) { SectionLabel("Pinned", Modifier.animateItem().padding(start = 6.dp, top = 8.dp)) }
                        }
                        items(others, key = { it.path }) { card(it, Modifier.animateItem()) }
                        if (pinned.isNotEmpty() && others.isNotEmpty()) {
                            item(key = "others-head", span = StaggeredGridItemSpan.FullLine) { SectionLabel("Others", Modifier.animateItem().padding(start = 6.dp, top = 8.dp)) }
                        } else if (unfiledHome && others.isNotEmpty() && (subfolders.isNotEmpty() || showRecent)) {
                            item(key = "unfiled-head", span = StaggeredGridItemSpan.FullLine) { SectionLabel("Unfiled", Modifier.animateItem().padding(start = 6.dp, top = 8.dp)) }
                        }
                    }
                }
                // Cards slide under the title rather than butting into it.
                Box(
                    Modifier.align(Alignment.TopCenter).fillMaxWidth().height(20.dp)
                        .background(Brush.verticalGradient(listOf(MaterialTheme.colorScheme.surfaceContainerLowest, Color.Transparent))),
                )
            }
        }

        // Search sits at the bottom where a thumb reaches it.
        // Only the search's keyboard counts: beside an open note (wide screens) the keyboard may be the note's.
        val keyboardUp = WindowInsets.ime.getBottom(LocalDensity.current) > 0 && searchFocused
        val showSearch = searchShown || keyboardUp || state.query.isNotEmpty() || list.isEmpty()
        val fade by animateDpAsState(toolbarClearance(extra = if (showSearch) 68.dp else 0.dp), MaterialTheme.motionScheme.defaultSpatialSpec(), label = "fade")
        // Notes fade out behind the search and toolbar instead of being cut off.
        if (!keyboardUp) {
            Box(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(fade)
                    .background(Brush.verticalGradient(listOf(Color.Transparent, MaterialTheme.colorScheme.surfaceContainerLowest.copy(alpha = 0.92f)))),
            )
        }
        // Full width just above the floating tabs; with the keyboard up it sits right on top of it instead.
        AnimatedVisibility(
            visible = showSearch,
            enter = slideInVertically(MaterialTheme.motionScheme.defaultSpatialSpec()) { it / 2 } + fadeIn(MaterialTheme.motionScheme.defaultEffectsSpec()),
            exit = slideOutVertically(MaterialTheme.motionScheme.fastSpatialSpec()) { it / 2 } + fadeOut(MaterialTheme.motionScheme.fastEffectsSpec()),
            modifier = Modifier.align(Alignment.BottomStart),
        ) {
        Row(
            Modifier
                .fillMaxWidth()
                .then(if (keyboardUp) Modifier.imePadding().padding(bottom = 8.dp) else Modifier.navigationBarsPadding().padding(bottom = TOOLBAR_BOTTOM + TOOLBAR_HEIGHT + 12.dp))
                .padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
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
                    focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
                    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                ),
                modifier = Modifier.weight(1f).shadow(6.dp, CircleShape).onFocusChanged { searchFocused = it.isFocused },
            )
            // How the notes are ordered, and whether home keeps filed notes to their folders.
            Box {
                Box(
                    Modifier.size(56.dp).shadow(6.dp, CircleShape).clip(CircleShape)
                        .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                        .clickable { haptics.tick(); filterMenu = true },
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Outlined.FilterList, "Sort and filter") }
                DropdownMenu(expanded = filterMenu, onDismissRequest = { filterMenu = false }) {
                    DropdownMenuItem(
                        text = { Text("Newest first") },
                        leadingIcon = { Icon(Icons.Outlined.Check, null, tint = if (byTitle) Color.Transparent else MaterialTheme.colorScheme.primary) },
                        onClick = { filterMenu = false; haptics.tick(); byTitle = false },
                    )
                    DropdownMenuItem(
                        text = { Text("Title A to Z") },
                        leadingIcon = { Icon(Icons.Outlined.Check, null, tint = if (byTitle) MaterialTheme.colorScheme.primary else Color.Transparent) },
                        onClick = { filterMenu = false; haptics.tick(); byTitle = true },
                    )
                    HorizontalDivider()
                    DropdownMenuItem(
                        text = { Text("Keep filed notes in folders") },
                        leadingIcon = { Icon(Icons.Outlined.Check, null, tint = if (hideFoldered) MaterialTheme.colorScheme.primary else Color.Transparent) },
                        onClick = { filterMenu = false; haptics.toggle(!hideFoldered); vm.setHideFoldered(!hideFoldered) },
                    )
                }
            }
        }
        }
        // Beside the floating tabs, level with them.
        if (!keyboardUp) {
            NewMenuFab(
                vm,
                state.folder,
                snackbar,
                onNewNote = onNew,
                onOpen = onOpen,
                modifier = Modifier.align(Alignment.BottomEnd).navigationBarsPadding().padding(bottom = TOOLBAR_BOTTOM - 16.dp + 4.dp),
            )
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(bottom = fade))
        PullUpDrawer(pullUp)
    }

    cardMenu?.let { n ->
        // Read fresh, so a pin or colour just changed shows as changed.
        val current = state.notes.firstOrNull { it.path == n.path } ?: n
        CardActionsSheet(
            current,
            onPin = { togglePin(current) },
            onColor = { c -> haptics.confirm(); act { if (c == null) vm.setCardMeta(n.path, clearColor = true) else vm.setCardMeta(n.path, color = c) } },
            onMove = { cardMenu = null; movingNote = current },
            onArchive = { cardMenu = null; scope.launch { archive(n) } },
            onDelete = { cardMenu = null; haptics.reject(); act { vm.trashCard(n.path) } },
            onDismiss = { cardMenu = null },
        )
    }
    movingNote?.let { n ->
        FolderPickerSheet(
            title = "Move “${n.title}” to",
            folders = state.folders,
            current = n.folder,
            onPick = { parent ->
                movingNote = null
                act { vm.moveCard(n.path, listOf(parent, n.path.substringAfterLast('/')).filter { it.isNotEmpty() }.joinToString("/")) }
            },
            onNewFolder = { path ->
                val (made, error) = vm.createFolderAt(path)
                error?.let { snackbar.showSnackbar(it) }
                made
            },
            onDismiss = { movingNote = null },
        )
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

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun NoteCard(n: NoteMeta, onOpen: (String) -> Unit, onLongPress: (NoteMeta) -> Unit, loadImage: suspend (String) -> ImageBitmap?, modifier: Modifier = Modifier) {
    val press = remember { MutableInteractionSource() }
    val firstLine = n.excerpt.orEmpty().trimStart().lineSequence().firstOrNull().orEmpty()
    // A note with no heading is named after its first line (Keep-style); showing both would repeat it.
    val showTitle = n.isBoard || n.snippet != null || n.title != n.fileName || !firstLine.startsWith(n.title)
    val outline = NOTE_HUES[n.color]?.copy(alpha = 0.45f) ?: MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f)
    Column(
        modifier
            .fillMaxWidth()
            .pressScale(press)
            .clip(RoundedCornerShape(16.dp))
            .background(noteTint(n.color))
            .border(1.dp, outline, RoundedCornerShape(16.dp))
            .combinedClickable(interactionSource = press, indication = LocalIndication.current, onLongClickLabel = "Note actions", onLongClick = { onLongPress(n) }) { onOpen(n.path) },
    ) {
        // The note's first image across the top, as Keep does; nothing until (unless) it loads.
        if (n.image != null && n.snippet == null) {
            val image by produceState<ImageBitmap?>(null, n.image) { value = loadImage(n.image) }
            image?.let { Image(it, null, Modifier.fillMaxWidth().heightIn(max = 200.dp), contentScale = ContentScale.Crop) }
        }
        Column(
            Modifier.padding(start = 14.dp, end = 12.dp, top = 12.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (showTitle || n.pinned) Row(verticalAlignment = Alignment.Top) {
                if (n.isBoard) {
                    Icon(Icons.Outlined.Draw, null, Modifier.size(20.dp).padding(top = 2.dp))
                    Spacer(Modifier.width(6.dp))
                }
                Text(
                    if (showTitle) n.title else "",
                    style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold, lineHeight = 21.sp),
                    modifier = Modifier.weight(1f),
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
                if (n.pinned) Icon(Icons.Filled.PushPin, "Pinned", Modifier.padding(start = 6.dp, top = 2.dp).size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (n.snippet != null) {
                Text(highlight(n.snippet), style = MaterialTheme.typography.bodyMedium, maxLines = 8, overflow = TextOverflow.Ellipsis)
            } else if (!n.isBoard) {
                Excerpt(n.excerpt.orEmpty())
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                Text(cardDate(n.mtime), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                // Just the folder's own name: a card is too narrow for a path.
                if (n.folder.isNotEmpty()) Pill(n.folder.substringAfterLast('/'))
                n.tags.take(2).forEach { Pill("#$it") }
            }
        }
    }
}

/**
 * Swipe right to pin or unpin, left to archive (or unarchive, in Archive/). Only on the grid: the Recent row scrolls
 * sideways, so a swipe there would fight it. The threshold is 40% of the card, so a sideways nudge while scrolling
 * springs back rather than acting.
 */
@Composable
private fun SwipeCard(n: NoteMeta, onPin: () -> Unit, onArchive: suspend () -> Unit, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val state = rememberSwipeToDismissBoxState(positionalThreshold = { it * 0.4f })
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    LaunchedEffect(state.targetValue) {
        if (state.targetValue != SwipeToDismissBoxValue.Settled) haptics.threshold()
    }
    val shape = RoundedCornerShape(16.dp)
    SwipeToDismissBox(
        modifier = modifier.clip(shape),
        state = state,
        onDismiss = { value ->
            // Pinned, the card moves sections with the same key, so its state stays: slide it back at once. Archived,
            // it stays swiped away until the move is done; then it's gone from the list, or comes back if that failed.
            scope.launch {
                if (value == SwipeToDismissBoxValue.StartToEnd) onPin() else onArchive()
                state.reset()
            }
        },
        backgroundContent = {
            val pin = state.dismissDirection == SwipeToDismissBoxValue.StartToEnd
            val archived = n.path.startsWith("Archive/", ignoreCase = true)
            val (bg, fg) = if (pin) MaterialTheme.colorScheme.secondaryContainer to MaterialTheme.colorScheme.onSecondaryContainer
                else MaterialTheme.colorScheme.tertiaryContainer to MaterialTheme.colorScheme.onTertiaryContainer
            Row(
                Modifier.fillMaxSize().background(bg, shape).padding(horizontal = 20.dp),
                horizontalArrangement = if (pin) Arrangement.Start else Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (pin) Icon(if (n.pinned) Icons.Outlined.PushPin else Icons.Filled.PushPin, if (n.pinned) "Unpin" else "Pin", tint = fg)
                else Icon(if (archived) Icons.Outlined.Unarchive else Icons.Outlined.Archive, if (archived) "Unarchive" else "Archive", tint = fg)
            }
        },
    ) { content() }
}

/** Card columns: as many as fit at 220dp or wider, but always at least two, Keep-style. */
private val CardColumns = object : StaggeredGridCells {
    override fun Density.calculateCrossAxisCellSizes(availableSize: Int, spacing: Int): IntArray {
        val count = maxOf(2, (availableSize + spacing) / (220.dp.roundToPx() + spacing))
        val size = (availableSize - spacing * (count - 1)) / count
        val left = availableSize - spacing * (count - 1) - size * count
        return IntArray(count) { size + if (it < left) 1 else 0 }
    }
}

/**
 * A card's quick actions on long press, so a note can be pinned, coloured, filed or binned without opening it: colour
 * first (boards have none, as on the web), then the actions, Delete last. Pin and colour leave the sheet open.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CardActionsSheet(
    n: NoteMeta,
    onPin: () -> Unit,
    onColor: (String?) -> Unit,
    onMove: () -> Unit,
    onArchive: () -> Unit,
    onDelete: () -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 12.dp)) {
            Text(
                n.title,
                style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 24.dp, end = 24.dp, bottom = 16.dp),
            )
            if (!n.isBoard) LazyRow(
                contentPadding = PaddingValues(horizontal = 20.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.padding(bottom = 8.dp),
            ) {
                item { Swatch(null, n.color == null) { onColor(null) } }
                items(NOTE_COLORS.size) { i -> Swatch(NOTE_COLORS[i], n.color == NOTE_COLORS[i]) { onColor(NOTE_COLORS[i]) } }
            }
            @Composable
            fun Item(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, danger: Boolean = false, onClick: () -> Unit) = Row(
                Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 24.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                val error = MaterialTheme.colorScheme.error
                Icon(icon, null, tint = if (danger) error else MaterialTheme.colorScheme.onSurfaceVariant)
                Text(label, style = MaterialTheme.typography.bodyLarge, color = if (danger) error else MaterialTheme.colorScheme.onSurface)
            }
            Item(if (n.pinned) Icons.Filled.PushPin else Icons.Outlined.PushPin, if (n.pinned) "Unpin" else "Pin", onClick = onPin)
            Item(Icons.AutoMirrored.Outlined.DriveFileMove, "Move to folder", onClick = onMove)
            val archived = n.path.startsWith("Archive/", ignoreCase = true)
            Item(if (archived) Icons.Outlined.Unarchive else Icons.Outlined.Archive, if (archived) "Unarchive" else "Archive", onClick = onArchive)
            Item(Icons.Outlined.Delete, "Delete", danger = true, onClick = onDelete)
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
private val IMAGE_LINE = Regex("""^\s*(?:(?:!\[\[[^\]]*]]|!\[[^\]]*]\([^)]*\))\s*)+$""")

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
        if (raw.isBlank() || raw.startsWith("%%") || RULE.matches(raw) || IMAGE_LINE.matches(raw)) continue
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
    val oneLine = if (small) 1 else 4
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

/** A card's date: the time today, "Yesterday", the weekday within the last week, else "12 Oct" (with the year when it isn't this one). */
private fun cardDate(ms: Long): String {
    val days = ((System.currentTimeMillis() - ms) / 86_400_000L).toInt()
    val locale = java.util.Locale.getDefault()
    fun fmt(skeleton: String) = android.text.format.DateFormat.format(android.text.format.DateFormat.getBestDateTimePattern(locale, skeleton), ms).toString()
    return when {
        android.text.format.DateUtils.isToday(ms) -> DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(ms))
        android.text.format.DateUtils.isToday(ms + 86_400_000L) -> "Yesterday"
        days in 0..5 -> fmt("EEE")
        else -> {
            val thisYear = java.util.Calendar.getInstance().get(java.util.Calendar.YEAR)
            val year = java.util.Calendar.getInstance().apply { timeInMillis = ms }.get(java.util.Calendar.YEAR)
            if (year == thisYear) fmt("d MMM") else DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(ms))
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

/** Links as their text, embeds and Tasks fields (dates, reminders, priority, repeat) dropped. Formatting marks stay for [inlineMarkdown]. */
private fun clean(s: String) = s
    .replace(Regex("""!\[\[[^\]]*]]|!\[[^\]]*]\([^)]*\)"""), "")
    .replace(Regex("""\[\[([^\]|]+)\|?([^\]]*)]]""")) { it.groupValues[2].ifEmpty { it.groupValues[1] } }
    .replace(Regex("""\[([^\]]+)]\([^)]*\)"""), "$1")
    .replace(Regex("""[📅⏳🛫✅➕❌]\uFE0F?\s*\d{4}-\d{2}-\d{2}|\(@[^)]*\)|(?:⏫|🔼|🔽|🔺|⏬)\uFE0F?|🔁\uFE0F?\s*every[^📅⏳🛫✅➕❌\n]*"""), "")
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
