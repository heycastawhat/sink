package nz.joshp.sink.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.runtime.remember
import androidx.compose.ui.unit.IntSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.StickyNote2
import androidx.compose.material.icons.outlined.Draw
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import nz.joshp.sink.data.NoteMeta
import java.text.DateFormat
import java.util.Calendar
import java.util.Date

/** A note in the Recent row: when it was last touched, and whether that was this phone opening it or an edit anywhere. */
data class Recent(val note: NoteMeta, val at: Long, val opened: Boolean)

/** The notes opened here or edited anywhere most lately, newest first. */
fun recentNotes(notes: List<NoteMeta>, opened: Map<String, Long>, count: Int = 8): List<Recent> =
    notes
        .map { n ->
            val o = opened[n.path] ?: 0L
            Recent(n, maxOf(n.mtime, o), o > n.mtime)
        }
        .sortedByDescending { it.at }
        .take(count)

/**
 * Home's Recent row, like Drive's suggested files: a label that folds it away, then preview cards that scroll
 * sideways. Mirrors the web's.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun RecentStrip(items: List<Recent>, shut: Boolean, onToggle: () -> Unit, onOpen: (String) -> Unit) {
    val motion = MaterialTheme.motionScheme
    val haptics = rememberHaptics()
    val turn by animateFloatAsState(if (shut) -90f else 0f, motion.defaultSpatialSpec(), label = "chevron")
    Column {
        Row(
            Modifier
                .clip(RoundedCornerShape(8.dp))
                .clickable {
                    haptics.tick()
                    onToggle()
                }
                .padding(start = 4.dp, end = 8.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Icon(Icons.Outlined.ExpandMore, if (shut) "Show recent" else "Hide recent", Modifier.size(20.dp).rotate(turn), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            SectionLabel("Recent")
        }
        // Folds away rather than vanishing: sizes use the effects spec (no overshoot), the fade the same.
        AnimatedVisibility(
            visible = !shut,
            enter = expandVertically(motion.defaultEffectsSpec<IntSize>()) + fadeIn(motion.defaultEffectsSpec()),
            exit = shrinkVertically(motion.defaultEffectsSpec<IntSize>()) + fadeOut(motion.defaultEffectsSpec()),
        ) {
            LazyRow(
                contentPadding = PaddingValues(top = 6.dp, bottom = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(items, key = { it.note.path }) { RecentCard(it, onOpen, Modifier.animateItem()) }
            }
        }
    }
}

/**
 * Home's Recent row when filed notes are kept off it: small tiles for the notes most lately touched inside folders,
 * each with its folder, so they're one tap away without opening the folder.
 */
@Composable
fun RecentFiledRow(items: List<Recent>, onOpen: (String) -> Unit) {
    LazyRow(
        contentPadding = PaddingValues(vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        items(items, key = { it.note.path }) { r ->
            val n = r.note
            val outline = NOTE_HUES[n.color]?.copy(alpha = 0.45f) ?: MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f)
            val press = remember { MutableInteractionSource() }
            Row(
                Modifier
                    .animateItem()
                    .widthIn(max = 220.dp)
                    .pressScale(press)
                    .clip(RoundedCornerShape(18.dp))
                    .background(noteTint(n.color))
                    .border(1.dp, outline, RoundedCornerShape(18.dp))
                    .clickable(interactionSource = press, indication = LocalIndication.current) { onOpen(n.path) }
                    .padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(
                    if (n.isBoard) Icons.Outlined.Draw else Icons.AutoMirrored.Outlined.StickyNote2,
                    null,
                    Modifier.size(24.dp),
                    tint = MaterialTheme.colorScheme.primary,
                )
                Column {
                    Text(n.title, style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        "${n.folder.substringAfterLast('/')} · ${shortTime(r.at)}",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun RecentCard(r: Recent, onOpen: (String) -> Unit, modifier: Modifier = Modifier) {
    val n = r.note
    val press = remember { MutableInteractionSource() }
    val outline = NOTE_HUES[n.color]?.copy(alpha = 0.45f) ?: MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f)
    Column(
        modifier
            .width(200.dp)
            .pressScale(press)
            .clip(RoundedCornerShape(16.dp))
            .background(noteTint(n.color))
            .border(1.dp, outline, RoundedCornerShape(16.dp))
            .clickable(interactionSource = press, indication = LocalIndication.current) { onOpen(n.path) }
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(Modifier.padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(
                if (n.isBoard) Icons.Outlined.Draw else Icons.AutoMirrored.Outlined.StickyNote2,
                null,
                Modifier.size(18.dp),
                tint = MaterialTheme.colorScheme.primary,
            )
            Text(
                n.title,
                style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        // The note's first lines on a paper-white sheet, like Drive's thumbnails.
        Box(
            Modifier
                .fillMaxWidth()
                .height(96.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(MaterialTheme.colorScheme.surfaceContainerLowest)
                .padding(horizontal = 10.dp, vertical = 8.dp),
            contentAlignment = if (n.isBoard) Alignment.Center else Alignment.TopStart,
        ) {
            if (n.isBoard) Icon(Icons.Outlined.Draw, null, Modifier.size(36.dp), tint = MaterialTheme.colorScheme.primary)
            else Excerpt(n.excerpt.orEmpty(), small = true)
        }
        Text(
            "You ${if (r.opened) "opened" else "edited"} · ${shortTime(r.at)}",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            modifier = Modifier.padding(horizontal = 4.dp),
        )
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
