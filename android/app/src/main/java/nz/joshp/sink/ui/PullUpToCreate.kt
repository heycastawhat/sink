package nz.joshp.sink.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectVerticalDragGestures
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
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** How far (after resistance) the drawer has to come up before letting go makes a note. */
private val THRESHOLD = 120.dp

/** How far the rubber band can stretch: the drawer slows towards this however far the finger goes. */
private val STRETCH = 360.dp

/** A flick up this fast (px/s) makes a note even short of [THRESHOLD], once the drawer's at least half way there. */
private const val FLICK = 1400f

/**
 * Pull up past the bottom of the notes to start a new one: a drawer follows the finger up from the bottom edge, and
 * letting go once it's far enough opens it into a new note (too short and it springs back). The list is laid out
 * bottom-up, so its bottom is where the newest notes are and a thumb already is.
 *
 * The drawer is on a rubber band: it follows the finger closely at first and stiffens the further it goes, so the
 * threshold is felt rather than overshot. Letting go uses the gesture's speed: a quick flick makes the note even a
 * little short of the line, and the drawer springs back (or on up into the note) from the speed the finger had.
 */
class PullUpToCreate internal constructor(
    private val scope: CoroutineScope,
    internal val thresholdPx: Float,
    private val stretch: Float,
    private val fullHeight: Float,
    private val onCreate: () -> Unit,
    private val tick: () -> Unit,
) {
    /** How far the finger has pulled, in px, before resistance. */
    private var raw = 0f

    /** How far the drawer is up, in px. */
    var pull by mutableFloatStateOf(0f)
        private set
    val ready get() = pull >= thresholdPx
    internal val progress get() = (pull / thresholdPx).coerceIn(0f, 1f)
    private var settling = false

    /** The rubber band: close to the finger at first (a little under half its travel), then ever stiffer towards [stretch]. */
    private fun band(x: Float) = stretch * (1f - 1f / (x * 0.55f / stretch + 1f))

    /** The finger moved [by] px up (negative: down). */
    internal fun drag(by: Float) {
        if (settling) return
        val wasReady = ready
        raw = (raw + by).coerceAtLeast(0f)
        pull = band(raw)
        if (ready != wasReady) tick()
    }

    internal val connection = object : NestedScrollConnection {
        // Finger back down while the drawer is out: the drawer goes down first, before the list scrolls.
        override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
            if (raw <= 0f || settling || source != NestedScrollSource.UserInput || available.y <= 0f) return Offset.Zero
            val take = minOf(available.y, raw)
            drag(-take)
            return Offset(0f, take)
        }

        // Finger up with nothing more below: what the list couldn't use lifts the drawer.
        override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
            if (settling || source != NestedScrollSource.UserInput || available.y >= 0f) return Offset.Zero
            drag(-available.y)
            return Offset(0f, available.y)
        }

        override suspend fun onPreFling(available: Velocity): Velocity {
            if (pull <= 0f) return Velocity.Zero
            // Upwards is negative on screen.
            release(-available.y)
            return available
        }
    }

    /** The finger's gone, moving up at [speed] px/s (negative: down). */
    internal fun release(speed: Float = 0f) {
        if (pull <= 0f || settling) return
        settling = true
        val create = ready || (speed > FLICK && pull >= thresholdPx / 2)
        raw = 0f
        scope.launch {
            try {
                if (create) {
                    if (!ready) tick()
                    // The drawer carries on up into the note, from the finger's speed; the note starts opening half way,
                    // so its own arrival follows on from the drawer's rather than waiting for it.
                    var opened = false
                    animate(pull, fullHeight, initialVelocity = speed.coerceAtLeast(0f), animationSpec = spring(dampingRatio = 1f, stiffness = 420f)) { v, _ ->
                        pull = v
                        if (!opened && v >= fullHeight / 2) {
                            opened = true
                            onCreate()
                        }
                    }
                    if (!opened) onCreate()
                } else {
                    // Back down with the speed it had, just short of a bounce.
                    animate(pull, 0f, initialVelocity = -speed, animationSpec = spring(dampingRatio = 0.85f, stiffness = 500f)) { v, _ -> pull = v.coerceAtLeast(0f) }
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
    val haptics = rememberHaptics()
    val density = LocalDensity.current
    val height = LocalConfiguration.current.screenHeightDp.dp
    val create by rememberUpdatedState(onCreate)
    return remember(scope, density, height, haptics) {
        PullUpToCreate(
            scope,
            thresholdPx = with(density) { THRESHOLD.toPx() },
            stretch = with(density) { STRETCH.toPx() },
            fullHeight = with(density) { height.toPx() },
            onCreate = { create() },
            tick = { haptics.threshold() },
        )
    }
}

/** Put on the scrolling list whose bottom the drawer comes up from. */
fun Modifier.pullUpToCreate(state: PullUpToCreate): Modifier = nestedScroll(state.connection)

/** Put on what the drawer comes up under: it rises a little with the drawer, as if the drawer were pushing it. */
fun Modifier.liftedByPullUp(state: PullUpToCreate): Modifier = graphicsLayer {
    translationY = -minOf(state.pull, state.thresholdPx * 1.5f) * 0.25f
}

/**
 * Put on the whole screen: a drag that starts on something that doesn't scroll (the search field, the space around
 * the toolbar, the fade over the list's end) pulls the drawer too. Drags on the list itself are the list's, and come
 * through [pullUpToCreate] instead; a tap still reaches whatever is under the finger.
 */
fun Modifier.pullUpFromAnywhere(state: PullUpToCreate): Modifier = pointerInput(state) {
    val velocity = VelocityTracker()
    detectVerticalDragGestures(
        onDragStart = { velocity.resetTracking() },
        onDragEnd = { state.release(-velocity.calculateVelocity().y) },
        onDragCancel = { state.release() },
    ) { change, dy ->
        velocity.addPosition(change.uptimeMillis, change.position)
        if (dy >= 0f && state.pull <= 0f) return@detectVerticalDragGestures
        change.consume()
        state.drag(-dy)
    }
}

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
            // The pen grows (and turns upright) with the pull, and swells with a spring as the line is crossed.
            val pop by animateFloatAsState(if (state.ready) 1.15f else 1f, spring(dampingRatio = 0.4f, stiffness = 500f), label = "drawer-pop")
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(
                    Icons.Outlined.Edit,
                    null,
                    Modifier.size(22.dp).graphicsLayer {
                        val s = (0.6f + 0.4f * state.progress) * pop
                        scaleX = s
                        scaleY = s
                        rotationZ = -20f * (1f - state.progress)
                    },
                    tint = fg,
                )
                Text(
                    if (state.ready) "Let go for a new note" else "Pull up for a new note",
                    style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold),
                    color = fg,
                )
            }
        }
    }
}
