package nz.joshp.sink.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.StickyNote2
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Draw
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import nz.joshp.sink.data.NoteMeta
import java.text.DateFormat
import java.util.Calendar
import java.util.Date

/** A note in Recents: when it was last touched, and whether that was this phone opening it or an edit anywhere. */
private data class Recent(val note: NoteMeta, val at: Long, val opened: Boolean)

/** Google Drive-style Recents: every note, most recently opened (here) or edited (anywhere) first, grouped by when. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class, ExperimentalFoundationApi::class)
@Composable
fun RecentsScreen(vm: NotesViewModel, onOpen: (String) -> Unit, onNew: () -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    val opened by vm.opened.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(Unit) { vm.refresh() }

    val groups = remember(state.notes, opened) {
        state.notes
            .map { n ->
                val o = opened[n.path] ?: 0L
                Recent(n, maxOf(n.mtime, o), o > n.mtime)
            }
            .sortedByDescending { it.at }
            .groupBy { bucket(it.at) }
            .toSortedMap()
    }

    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceContainerLowest)) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            ScreenTitle("Recents", trailing = {
                if (state.offline) Icon(Icons.Outlined.CloudOff, "Offline", Modifier.padding(12.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            })
            PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = { vm.refresh(pull = true) }, modifier = Modifier.fillMaxSize()) {
                when {
                    !state.loaded -> Box(Modifier.fillMaxSize(), Alignment.Center) { LoadingIndicator() }
                    state.notes.isEmpty() && state.error != null -> EmptyState("Can't reach your notes", state.error ?: "")
                    state.notes.isEmpty() -> EmptyState("Nothing here yet", "Notes you open or edit show up here, newest first.")
                    else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
                        for ((b, items) in groups) {
                            stickyHeader(key = "h$b") {
                                SectionLabel(
                                    BUCKETS[b],
                                    Modifier
                                        .fillMaxWidth()
                                        .background(MaterialTheme.colorScheme.surfaceContainerLowest)
                                        .padding(start = 20.dp, top = 14.dp, bottom = 6.dp),
                                )
                            }
                            items(items, key = { it.note.path }) { RecentRow(it, onOpen) }
                        }
                    }
                }
            }
        }
        NewMenuFab(vm, "", snackbar, onNewNote = onNew, onOpen = onOpen, modifier = Modifier.align(Alignment.BottomEnd).padding(bottom = 8.dp))
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(bottom = 80.dp))
    }
}

@Composable
private fun RecentRow(r: Recent, onOpen: (String) -> Unit) {
    val n = r.note
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { onOpen(n.path) }
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        // The note's own colour, as on its card; plain notes use the theme's tonal container.
        Box(
            Modifier
                .size(40.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(noteTint(n.color, MaterialTheme.colorScheme.secondaryContainer, 0.55f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                if (n.isBoard) Icons.Outlined.Draw else Icons.AutoMirrored.Outlined.StickyNote2,
                null,
                Modifier.size(22.dp),
                tint = MaterialTheme.colorScheme.onSecondaryContainer,
            )
        }
        Column(Modifier.weight(1f)) {
            Text(
                n.title,
                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                "${n.folder.ifEmpty { "Notes" }} · ${if (r.opened) "Opened" else "Edited"} ${shortTime(r.at)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

private val BUCKETS = listOf("Today", "Yesterday", "Earlier this week", "Earlier this month", "Older")

/** Which header a time goes under, in local time: 0 today … 4 older. */
private fun bucket(ms: Long): Int {
    val day = Calendar.getInstance().apply {
        set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
    }
    val today = day.timeInMillis
    val yesterday = today - 24 * 60 * 60 * 1000L
    val week = (day.clone() as Calendar).apply { set(Calendar.DAY_OF_WEEK, firstDayOfWeek) }.timeInMillis
    val month = (day.clone() as Calendar).apply { set(Calendar.DAY_OF_MONTH, 1) }.timeInMillis
    return when {
        ms >= today -> 0
        ms >= yesterday -> 1
        ms >= week -> 2
        ms >= month -> 3
        else -> 4
    }
}

/** "3:14 pm" today, else "12 Oct" (with the year when it isn't this one). */
private fun shortTime(ms: Long): String {
    val now = Calendar.getInstance()
    val then = Calendar.getInstance().apply { timeInMillis = ms }
    return when {
        android.text.format.DateUtils.isToday(ms) -> DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(ms))
        then.get(Calendar.YEAR) == now.get(Calendar.YEAR) ->
            android.text.format.DateFormat.format(android.text.format.DateFormat.getBestDateTimePattern(java.util.Locale.getDefault(), "d MMM"), ms).toString()
        else -> DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(ms))
    }
}
