package nz.joshp.sink.ui

import android.os.Build
import android.view.HapticFeedbackConstants
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** How far (after resistance) the drawer has to come up before letting go makes a note. */
private val THRESHOLD = 140.dp

/**
 * Pull up past the bottom of the notes to start a new one: a drawer follows the finger up from the bottom edge, and
 * letting go once it's far enough opens it into a new note (too short and it slides back). The list is laid out
 * bottom-up, so its bottom is where the newest notes are and a thumb already is.
 */
class PullUpToCreate internal constructor(
    private val scope: CoroutineScope,
    private val threshold: Float,
    private val fullHeight: Float,
    private val onCreate: () -> Unit,
    private val tick: () -> Unit,
) {
    /** How far the drawer is up, in px. */
    var pull by mutableFloatStateOf(0f)
        private set
    val ready get() = pull >= threshold
    internal val progress get() = (pull / threshold).coerceIn(0f, 1f)
    private var settling = false

    private fun drag(by: Float) {
        val wasReady = ready
        pull = (pull + by).coerceAtLeast(0f)
        if (ready != wasReady) tick()
    }

    internal val connection = object : NestedScrollConnection {
        // Finger back down while the drawer is out: the drawer goes down first, before the list scrolls.
        override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
            if (pull <= 0f || settling || source != NestedScrollSource.UserInput || available.y <= 0f) return Offset.Zero
            val take = minOf(available.y, pull)
            drag(-take)
            return Offset(0f, take)
        }

        // Finger up with nothing more below: what the list couldn't use lifts the drawer (with some resistance).
        override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
            if (settling || source != NestedScrollSource.UserInput || available.y >= 0f) return Offset.Zero
            drag(-available.y * 0.55f)
            return Offset(0f, available.y)
        }

        override suspend fun onPreFling(available: Velocity): Velocity {
            if (pull <= 0f) return Velocity.Zero
            release()
            return available
        }
    }

    private fun release() {
        settling = true
        val create = ready
        scope.launch {
            try {
                if (create) {
                    // The drawer opens up into the note.
                    animate(pull, fullHeight, animationSpec = tween(200)) { v, _ -> pull = v }
                    onCreate()
                } else {
                    animate(pull, 0f, animationSpec = tween(220)) { v, _ -> pull = v }
                }
            } finally {
                pull = 0f
                settling = false
            }
        }
    }
}

@Composable
fun rememberPullUpToCreate(onCreate: () -> Unit): PullUpToCreate {
    val scope = rememberCoroutineScope()
    val view = LocalView.current
    val density = LocalDensity.current
    val height = LocalConfiguration.current.screenHeightDp.dp
    val create by rememberUpdatedState(onCreate)
    return remember(scope, density, height) {
        PullUpToCreate(
            scope,
            threshold = with(density) { THRESHOLD.toPx() },
            fullHeight = with(density) { height.toPx() },
            onCreate = { create() },
            tick = {
                view.performHapticFeedback(
                    if (Build.VERSION.SDK_INT >= 34) HapticFeedbackConstants.GESTURE_THRESHOLD_ACTIVATE else HapticFeedbackConstants.CONTEXT_CLICK,
                )
            },
        )
    }
}

/** Put on the scrolling list whose bottom the drawer comes up from. */
fun Modifier.pullUpToCreate(state: PullUpToCreate): Modifier = nestedScroll(state.connection)

/** The drawer itself, over everything at the bottom of the screen (the search field and toolbar included). */
@Composable
fun BoxScope.PullUpDrawer(state: PullUpToCreate) {
    if (state.pull <= 0f) return
    val height = with(LocalDensity.current) { state.pull.toDp() }
    val colors = MaterialTheme.colorScheme
    val bg by animateColorAsState(if (state.ready) colors.primaryContainer else colors.surfaceContainerHighest, label = "drawer")
    val fg = if (state.ready) colors.onPrimaryContainer else colors.onSurfaceVariant
    Box(
        Modifier
            .align(Alignment.BottomCenter)
            .fillMaxWidth()
            .height(height)
            .clip(RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp))
            .background(bg),
    ) {
        Column(
            Modifier.fillMaxWidth().padding(top = 10.dp).alpha(state.progress),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Box(Modifier.width(36.dp).height(4.dp).clip(CircleShape).background(fg.copy(alpha = 0.5f)))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(Icons.Outlined.Edit, null, Modifier.size(22.dp), tint = fg)
                Text(
                    if (state.ready) "Let go for a new note" else "Pull up for a new note",
                    style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold),
                    color = fg,
                )
            }
        }
    }
}
