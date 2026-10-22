package nz.joshp.sink.ui

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.ui.platform.LocalContext
import nz.joshp.sink.reminders.ReminderSync
import nz.joshp.sink.reminders.Reminders
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.staggeredgrid.LazyVerticalStaggeredGrid
import androidx.compose.foundation.lazy.staggeredgrid.StaggeredGridCells
import androidx.compose.foundation.lazy.staggeredgrid.StaggeredGridItemSpan
import androidx.compose.foundation.lazy.staggeredgrid.items
import androidx.compose.foundation.lazy.staggeredgrid.rememberLazyStaggeredGridState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.CloudUpload
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.ButtonGroupDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
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
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.ToggleButton
import androidx.compose.material3.ToggleButtonDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.toShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil3.compose.AsyncImage
import nz.joshp.sink.data.Capture

private val VIEW_ICONS = mapOf(
    View.All to Icons.Outlined.Inventory2,
    View.Review to Icons.Outlined.AutoAwesome,
    View.Pinned to Icons.Outlined.PushPin,
    View.Archived to Icons.Outlined.Archive,
    View.Trash to Icons.Outlined.Delete,
)

@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class, ExperimentalFoundationApi::class)
@Composable
fun HomeScreen(vm: SinkViewModel, serverUrl: String, onOpen: (String) -> Unit, onSettings: () -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    val uploading by vm.uploading.collectAsStateWithLifecycle()
    val grid = rememberLazyStaggeredGridState()

    val nearEnd by remember {
        derivedStateOf {
            val last = grid.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            last >= grid.layoutInfo.totalItemsCount - 8
        }
    }
    LaunchedEffect(nearEnd, state.items.size) { if (nearEnd) vm.loadMore() }

    // Reminders need notifications; ask once, the first time the sink is opened.
    val context = LocalContext.current
    val notifyPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) ReminderSync.now(context)
    }
    LaunchedEffect(Unit) {
        if (!Reminders.canNotify(context)) notifyPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    Scaffold(containerColor = MaterialTheme.colorScheme.surface) { inner ->
        Column(Modifier.padding(top = inner.calculateTopPadding()).fillMaxSize()) {
            // Search
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextField(
                    value = state.query,
                    onValueChange = vm::setQuery,
                    placeholder = { Text("Search the sink") },
                    leadingIcon = { Icon(Icons.Outlined.Search, null) },
                    trailingIcon = {
                        if (state.query.isNotEmpty()) {
                            IconButton(onClick = { vm.setQuery("") }) { Icon(Icons.Outlined.Close, "Clear") }
                        }
                    },
                    singleLine = true,
                    shape = CircleShape,
                    colors = TextFieldDefaults.colors(
                        focusedIndicatorColor = MaterialTheme.colorScheme.surface.copy(alpha = 0f),
                        unfocusedIndicatorColor = MaterialTheme.colorScheme.surface.copy(alpha = 0f),
                        focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                        unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                    ),
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = onSettings) { Icon(Icons.Outlined.Settings, "Settings") }
            }

            // Views: connected expressive button group
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(ButtonGroupDefaults.ConnectedSpaceBetween),
            ) {
                View.entries.forEachIndexed { i, v ->
                    ToggleButton(
                        checked = state.view == v,
                        onCheckedChange = { vm.setView(v) },
                        shapes = when (i) {
                            0 -> ButtonGroupDefaults.connectedLeadingButtonShapes()
                            View.entries.lastIndex -> ButtonGroupDefaults.connectedTrailingButtonShapes()
                            else -> ButtonGroupDefaults.connectedMiddleButtonShapes()
                        },
                        modifier = Modifier.weight(if (state.view == v) 1.6f else 1f),
                        contentPadding = PaddingValues(horizontal = 8.dp),
                    ) {
                        Icon(VIEW_ICONS.getValue(v), null, Modifier.size(ToggleButtonDefaults.IconSize))
                        if (state.view == v) {
                            Spacer(Modifier.width(6.dp))
                            Text(v.label, maxLines = 1)
                        }
                    }
                }
            }

            // Kinds (the review list ignores filters, so they hide there)
            if (state.view != View.Review) LazyRow(
                contentPadding = PaddingValues(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(KINDS, key = { it.id }) { k ->
                    FilterChip(
                        selected = state.kind == k.id,
                        onClick = { vm.setKind(k.id) },
                        label = { Text(k.label) },
                        leadingIcon = { Icon(k.icon, null, Modifier.size(FilterChipDefaults.IconSize)) },
                    )
                }
            }

            if (state.view != View.Review) CollectionsRow(vm, state.collections, state.collection)

            AnimatedVisibility(uploading > 0) {
                Surface(
                    color = MaterialTheme.colorScheme.secondaryContainer,
                    shape = CircleShape,
                    modifier = Modifier.padding(start = 16.dp, top = 8.dp),
                ) {
                    Row(Modifier.padding(horizontal = 14.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.CloudUpload, null, Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Stashing $uploading…", style = MaterialTheme.typography.labelLarge)
                    }
                }
            }

            PullToRefreshBox(
                isRefreshing = state.refreshing,
                onRefresh = vm::refresh,
                modifier = Modifier.fillMaxSize(),
            ) {
                when {
                    state.items.isEmpty() && state.loading -> Box(Modifier.fillMaxSize(), Alignment.Center) { LoadingIndicator() }
                    state.items.isEmpty() && state.error != null -> EmptyState("Can't reach the sink", "${state.error}\n$serverUrl")
                    state.items.isEmpty() && state.done -> EmptyState(
                        when {
                            state.view == View.Review -> "All caught up"
                            state.query.isNotBlank() -> "Nothing matches"
                            state.collection != null -> "Nothing in here yet"
                            state.view == View.Trash -> "Trash is empty"
                            state.view == View.Archived -> "Archive is empty"
                            state.view == View.Pinned -> "No pins yet"
                            else -> "Sink's empty"
                        },
                        when {
                            state.view == View.Review -> "Nothing from this week left to look at."
                            state.query.isNotBlank() -> "Try fewer words."
                            state.collection != null -> "Open a capture and file it into this collection."
                            state.view == View.All -> "Take a screenshot, or share any image to Sink."
                            else -> ""
                        },
                    )
                    else -> CaptureGrid(state, grid, onOpen, onReview = if (state.view == View.Review) vm::review else null)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun CaptureGrid(
    state: SinkState,
    grid: androidx.compose.foundation.lazy.staggeredgrid.LazyStaggeredGridState,
    onOpen: (String) -> Unit,
    onReview: ((String, Boolean) -> Unit)? = null,
) {
    // Day headers when browsing by date; search results are ranked so they stay flat.
    val groups = remember(state.items, state.query) {
        if (state.query.isNotBlank()) listOf("" to state.items)
        else state.items.groupBy { relativeDay(it.createdAt) }.toList()
    }
    LazyVerticalStaggeredGrid(
        columns = StaggeredGridCells.Adaptive(160.dp),
        state = grid,
        contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 96.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalItemSpacing = 10.dp,
        modifier = Modifier.fillMaxSize(),
    ) {
        for ((day, items) in groups) {
            if (day.isNotEmpty()) {
                item(key = "day-$day", span = StaggeredGridItemSpan.FullLine) {
                    Text(
                        day,
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = 6.dp, top = 12.dp, bottom = 2.dp),
                    )
                }
            }
            items(items, key = { it.id }) { c ->
                if (onReview == null) CaptureCard(c, onClick = { onOpen(c.id) }, Modifier.animateItem())
                else Column(Modifier.animateItem(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    CaptureCard(c, onClick = { onOpen(c.id) })
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        FilledTonalButton(onClick = { onReview(c.id, false) }, Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 8.dp)) {
                            Icon(Icons.Outlined.Check, null, Modifier.size(18.dp))
                            Spacer(Modifier.width(4.dp))
                            Text("Keep")
                        }
                        TextButton(onClick = { onReview(c.id, true) }, Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 8.dp)) {
                            Icon(Icons.Outlined.Archive, null, Modifier.size(18.dp))
                            Spacer(Modifier.width(4.dp))
                            Text("Archive")
                        }
                    }
                }
            }
        }
        if (state.loading && state.items.isNotEmpty()) {
            item(span = StaggeredGridItemSpan.FullLine) {
                Box(Modifier.fillMaxWidth().padding(16.dp), Alignment.Center) { LoadingIndicator() }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun CaptureCard(c: Capture, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val kind = kindOf(c.kind)
    val pinned = c.pinned
    Card(
        onClick = onClick,
        shape = RoundedCornerShape(24.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (pinned) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer,
        ),
        modifier = modifier,
    ) {
        Box {
            AsyncImage(
                model = c.thumbUrl.let { CaptureImages.absolute(it) },
                contentDescription = null,
                contentScale = ContentScale.Crop,
                alignment = Alignment.TopCenter,
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(c.width.toFloat() / minOf(c.height.toFloat(), c.width * 1.6f))
                    .background(MaterialTheme.colorScheme.surfaceContainerHighest),
            )
            if (c.busy) {
                Box(
                    Modifier
                        .matchParentSize()
                        .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.45f)),
                    Alignment.Center,
                ) { ContainedLoadingIndicator() }
            }
            if (pinned) {
                Box(
                    Modifier
                        .align(Alignment.TopEnd)
                        .padding(8.dp)
                        .size(30.dp)
                        .clip(MaterialShapes.Cookie4Sided.toShape())
                        .background(MaterialTheme.colorScheme.primary),
                    Alignment.Center,
                ) { Icon(Icons.Filled.PushPin, "Pinned", Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onPrimary) }
            }
        }
        Column(Modifier.padding(12.dp)) {
            Text(
                c.title ?: c.note ?: if (c.busy) "Reading…" else "Untitled",
                style = MaterialTheme.typography.titleSmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            c.summary?.let {
                Spacer(Modifier.height(4.dp))
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (pinned) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                when {
                    c.status == "failed" -> Pill(Icons.Outlined.ErrorOutline, "AI failed", error = true)
                    kind != null -> Pill(kind.icon, kind.id)
                }
                Spacer(Modifier.weight(1f))
                Text(timeOf(c.createdAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun Pill(icon: ImageVector, label: String, error: Boolean = false) {
    Surface(
        shape = CircleShape,
        color = if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.secondaryContainer,
        contentColor = if (error) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSecondaryContainer,
    ) {
        Row(Modifier.padding(start = 6.dp, end = 10.dp, top = 3.dp, bottom = 3.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, Modifier.size(14.dp))
            Spacer(Modifier.width(4.dp))
            Text(label.replaceFirstChar { it.uppercase() }, style = MaterialTheme.typography.labelSmall)
        }
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun EmptyState(title: String, body: String) {
    Column(
        Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            Modifier
                .size(120.dp)
                .clip(MaterialShapes.Ghostish.toShape())
                .background(MaterialTheme.colorScheme.tertiaryContainer),
        )
        Spacer(Modifier.height(24.dp))
        Text(title, style = MaterialTheme.typography.titleLarge)
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
