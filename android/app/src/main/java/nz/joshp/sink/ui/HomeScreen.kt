package nz.joshp.sink.ui

import android.Manifest
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.CloudUpload
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ContainedLoadingIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialShapes
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.toShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil3.compose.AsyncImage
import kotlinx.coroutines.launch
import nz.joshp.sink.data.Capture
import nz.joshp.sink.reminders.ReminderSync
import nz.joshp.sink.reminders.Reminders

/**
 * The capture grid. Used for the Sink and Review tabs, and for Pinned / Archive / Trash / a collection
 * opened from Library (those get a back arrow).
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun HomeScreen(
    vm: SinkViewModel,
    serverUrl: String,
    view: View,
    collection: String? = null,
    onOpen: (String) -> Unit,
    onBack: (() -> Unit)? = null,
) {
    LaunchedEffect(view, collection) { vm.show(view, collection) }
    val state by vm.state.collectAsStateWithLifecycle()
    val uploading by vm.uploading.collectAsStateWithLifecycle()
    val grid = rememberLazyGridState()
    val context = LocalContext.current
    val col = state.collections.firstOrNull { it.id == collection }
    val review = view == View.Review
    // Ignore the previous screen's items for the frame before show() swaps them out.
    val current = state.view == view && state.collection == collection

    val nearEnd by remember {
        derivedStateOf {
            val last = grid.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            last >= grid.layoutInfo.totalItemsCount - 8
        }
    }
    LaunchedEffect(nearEnd, state.items.size) { if (nearEnd && current) vm.loadMore() }

    // Reminders need notifications; ask once, the first time the sink is opened.
    val notifyPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) ReminderSync.now(context)
    }
    LaunchedEffect(Unit) {
        if (!Reminders.canNotify(context)) notifyPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    // Add: system photo picker, then the usual "why are you saving this?" sheet.
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(20)) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        context.startActivity(
            Intent(context, CaptureActivity::class.java)
                .setAction(Intent.ACTION_SEND_MULTIPLE)
                .setType("image/*")
                .putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris))
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
        )
    }

    val title = col?.name ?: when (view) {
        View.All -> "Sink"
        else -> view.label
    }

    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceContainerLowest)) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            ScreenTitle(
                title,
                sub = col?.let { "${it.count} capture${if (it.count == 1) "" else "s"}" },
                onBack = onBack,
                trailing = { if (col != null) CollectionTools(vm, col.id, col.name, onDeleted = { onBack?.invoke() }) },
            )

            if (!review) {
                TextField(
                    value = if (current) state.query else "",
                    onValueChange = vm::setQuery,
                    placeholder = { Text("Search by words or meaning") },
                    leadingIcon = { Icon(Icons.Outlined.Search, null) },
                    trailingIcon = {
                        if (state.query.isNotEmpty()) IconButton(onClick = { vm.setQuery("") }) { Icon(Icons.Outlined.Close, "Clear") }
                    },
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
                LazyRow(
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(KINDS, key = { it.id }) { k ->
                        FilterChip(
                            selected = state.kind == k.id,
                            onClick = { vm.setKind(k.id) },
                            label = { Text(k.label) },
                            leadingIcon = {
                                Icon(k.icon, null, Modifier.size(FilterChipDefaults.IconSize), tint = kindInk(k.hue))
                            },
                        )
                    }
                }
            }

            AnimatedVisibility(uploading > 0) {
                Surface(
                    color = MaterialTheme.colorScheme.secondaryContainer,
                    shape = CircleShape,
                    modifier = Modifier.padding(start = 16.dp, bottom = 6.dp),
                ) {
                    Row(Modifier.padding(horizontal = 14.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.CloudUpload, null, Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Stashing $uploading…", style = MaterialTheme.typography.labelLarge)
                    }
                }
            }

            PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = vm::refresh, modifier = Modifier.fillMaxSize()) {
                val items = if (current) state.items else emptyList()
                when {
                    items.isEmpty() && (state.loading || !current) -> Box(Modifier.fillMaxSize(), Alignment.Center) { LoadingIndicator() }
                    items.isEmpty() && state.error != null -> EmptyState("Can't reach the sink", "${state.error}\n$serverUrl")
                    items.isEmpty() && state.done -> EmptyState(
                        when {
                            review -> "All caught up"
                            state.query.isNotBlank() -> "Nothing matches"
                            col != null -> "Nothing in here yet"
                            view == View.Trash -> "Trash is empty"
                            view == View.Archived -> "Archive is empty"
                            view == View.Pinned -> "No pins yet"
                            else -> "Sink's empty"
                        },
                        when {
                            review -> "Nothing from this week left to look at."
                            state.query.isNotBlank() -> "Try fewer words."
                            col != null -> "Open a capture and file it into this collection."
                            view == View.All -> "Take a screenshot, or share any image to Sink."
                            else -> ""
                        },
                    )
                    else -> CaptureGrid(items, state.query, state.loading, grid, onOpen, review = if (review) vm::review else null)
                }
            }
        }

        if (!review && view != View.Trash) {
            SmallFloatingActionButton(
                onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                containerColor = MaterialTheme.colorScheme.primaryContainer,
                modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
            ) { Icon(Icons.Outlined.Add, "Add screenshots") }
        }
    }
}

/** Big page title, Sink style, with an optional back arrow and trailing tools. */
@Composable
fun ScreenTitle(title: String, sub: String? = null, onBack: (() -> Unit)? = null, trailing: @Composable () -> Unit = {}) {
    Row(
        Modifier.fillMaxWidth().padding(start = if (onBack != null) 4.dp else 20.dp, end = 8.dp, top = 12.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") }
        Column(Modifier.weight(1f)) {
            Text(
                title,
                style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.5).sp),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            sub?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        trailing()
    }
}

@Composable
private fun CollectionTools(vm: SinkViewModel, id: String, name: String, onDeleted: () -> Unit) {
    var renaming by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    IconButton(onClick = { renaming = true }) { Icon(Icons.Outlined.Edit, "Rename collection") }
    IconButton(onClick = { deleting = true }) { Icon(Icons.Outlined.Delete, "Delete collection") }
    if (renaming) {
        NameDialog("Rename collection", name, onDismiss = { renaming = false }) { vm.renameCollection(id, it).map { } }
    }
    if (deleting) {
        AlertDialog(
            onDismissRequest = { deleting = false },
            title = { Text("Delete “$name”?") },
            text = { Text("The captures in it stay in the sink.") },
            confirmButton = {
                TextButton(onClick = {
                    deleting = false
                    scope.launch { if (vm.deleteCollection(id).isSuccess) onDeleted() }
                }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { deleting = false }) { Text("Cancel") } },
        )
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun CaptureGrid(
    items: List<Capture>,
    query: String,
    loading: Boolean,
    grid: LazyGridState,
    onOpen: (String) -> Unit,
    review: ((String, Boolean) -> Unit)?,
) {
    // Day headers when browsing by date; search results are ranked so they stay flat.
    val groups = remember(items, query) {
        if (query.isNotBlank()) listOf("" to items) else items.groupBy { relativeDay(it.createdAt) }.toList()
    }
    LazyVerticalGrid(
        columns = GridCells.Adaptive(150.dp),
        state = grid,
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 96.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        if (review != null) {
            item(key = "review-head", span = { GridItemSpan(maxLineSpan) }) { ReviewHeader(items.size) }
        }
        for ((day, dayItems) in groups) {
            if (day.isNotEmpty() && review == null) {
                item(key = "day-$day", span = { GridItemSpan(maxLineSpan) }) {
                    Row(Modifier.padding(start = 2.dp, top = 6.dp), verticalAlignment = Alignment.Bottom) {
                        Text(day, style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold))
                        Spacer(Modifier.width(8.dp))
                        Text("${dayItems.size}", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            items(dayItems, key = { it.id }) { c ->
                Column(Modifier.animateItem(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    CaptureCard(c, onClick = { onOpen(c.id) })
                    if (review != null) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            FilledTonalButton(onClick = { review(c.id, false) }, Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 8.dp)) {
                                Icon(Icons.Outlined.Check, null, Modifier.size(18.dp))
                                Spacer(Modifier.width(4.dp))
                                Text("Keep")
                            }
                            TextButton(onClick = { review(c.id, true) }, Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 8.dp)) {
                                Icon(Icons.Outlined.Archive, null, Modifier.size(18.dp))
                                Spacer(Modifier.width(4.dp))
                                Text("Archive")
                            }
                        }
                    }
                }
            }
        }
        if (loading && items.isNotEmpty()) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                Box(Modifier.fillMaxWidth().padding(16.dp), Alignment.Center) { LoadingIndicator() }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun ReviewHeader(count: Int) {
    Surface(shape = RoundedCornerShape(28.dp), color = MaterialTheme.colorScheme.tertiaryContainer) {
        Row(Modifier.fillMaxWidth().padding(20.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(52.dp)
                    .clip(MaterialShapes.Sunny.toShape())
                    .background(MaterialTheme.colorScheme.tertiary),
            )
            Spacer(Modifier.width(16.dp))
            Column {
                Text("This week in the sink", style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold))
                Text(
                    if (count > 0) "$count thing${if (count == 1) "" else "s"} you saved and haven't looked at again." else "All caught up. Nice.",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

/** Text/icon colour for a kind, readable on light and dark surfaces. */
@Composable
fun kindInk(hue: Color) = lerp(MaterialTheme.colorScheme.onSurface, hue, 0.78f)

/** Kind label tinted with its hue, e.g. a coral "Event". */
@Composable
fun KindPill(icon: ImageVector, label: String, hue: Color) {
    Row(
        Modifier
            .clip(CircleShape)
            .background(lerp(MaterialTheme.colorScheme.surfaceContainerLowest, hue, 0.16f))
            .padding(start = 6.dp, end = 9.dp, top = 2.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, Modifier.size(14.dp), tint = kindInk(hue))
        Spacer(Modifier.width(4.dp))
        Text(label, style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold), color = kindInk(hue))
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun CaptureCard(c: Capture, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val kind = kindOf(c.kind)
    val tile = RoundedCornerShape(18.dp)
    // No clip on the whole card: a rounded clip would shave the corners off the text under the tile.
    Column(modifier.clickable(onClick = onClick), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(4f / 5f)
                .clip(tile)
                .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                .border(BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f)), tile),
        ) {
            AsyncImage(
                model = CaptureImages.absolute(c.thumbUrl),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                alignment = Alignment.TopCenter,
                modifier = Modifier.fillMaxSize(),
            )
            if (c.busy) {
                Box(Modifier.matchParentSize().background(MaterialTheme.colorScheme.surface.copy(alpha = 0.45f)), Alignment.Center) {
                    ContainedLoadingIndicator()
                }
            }
            if (c.pinned) {
                Box(
                    Modifier
                        .align(Alignment.TopEnd)
                        .padding(8.dp)
                        .size(28.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.primary),
                    Alignment.Center,
                ) { Icon(Icons.Filled.PushPin, "Pinned", Modifier.size(15.dp), tint = MaterialTheme.colorScheme.onPrimary) }
            }
        }
        Spacer(Modifier.height(6.dp))
        when {
            c.status == "failed" -> Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.ErrorOutline, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.error)
                Spacer(Modifier.width(4.dp))
                Text("AI failed", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
            }
            kind != null -> KindPill(kind.icon, kind.one, kind.hue)
        }
        Text(
            c.title ?: c.note ?: if (c.busy) "Reading…" else "Untitled",
            style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 2.dp),
        )
        c.summary?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(horizontal = 2.dp),
            )
        }
        Text(
            timeOf(c.createdAt),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 2.dp),
        )
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun EmptyState(title: String, body: String) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            Modifier
                .size(112.dp)
                .clip(MaterialShapes.Ghostish.toShape())
                .background(MaterialTheme.colorScheme.tertiaryContainer),
        )
        Spacer(Modifier.height(24.dp))
        Text(title, style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold))
        if (body.isNotEmpty()) {
            Spacer(Modifier.height(8.dp))
            Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** Server returns relative media paths; Coil needs absolute URLs. */
object CaptureImages {
    @Volatile
    var base: String = ""
    fun absolute(path: String) = if (path.startsWith("http")) path else base + path
}
