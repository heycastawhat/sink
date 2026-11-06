package nz.joshp.sink.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * The app's entrance as the splash screen leaves: the notes rise into place, then the tabs slide up after them (as
 * Hocket's shell does). Only a splash exit plays it: it [hide]s the app under the still-opaque splash and [play]s the
 * entrance as the splash starts to clear, so it's seen rather than spent under the splash. Without a splash exit (a
 * warm start, a recreation, below API 31) nothing hides the app: it's just there.
 */
object Entrance {
    internal enum class Phase { Shown, Hidden, Entering }

    internal var phase by mutableStateOf(Phase.Shown)
        private set

    /** The splash is about to leave: the app waits, unseen, under it. */
    fun hide() {
        phase = Phase.Hidden
    }

    /** The splash is clearing: a hidden app comes in. */
    fun play() {
        if (phase == Phase.Hidden) phase = Phase.Entering
    }

    /** No entrance after all (a recreation): the app is just there. */
    fun finish() {
        phase = Phase.Shown
    }

    /** The entrance's linear progress, 0 to 1 (1 whenever none is due). Read it in a graphics layer, not in composition. */
    internal val progress = Animatable(1f)

    const val DURATION_MS = 840
    const val PAGE_END_MS = 520
    const val BAR_START_MS = 100
    const val BAR_END_MS = 420
}

/** M3's emphasized decelerate: things arriving on screen. */
private val EmphasizedDecelerate = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1f)

/** Drives the entrance; returns its progress (0 to 1) for graphics layers to read. */
@Composable
fun rememberEntrance(): () -> Float {
    val phase = Entrance.phase
    LaunchedEffect(phase) {
        when (phase) {
            Entrance.Phase.Shown -> Entrance.progress.snapTo(1f)
            Entrance.Phase.Hidden -> Entrance.progress.snapTo(0f)
            Entrance.Phase.Entering -> {
                // From the start even if the hidden frame never got drawn (hide and play can land together).
                Entrance.progress.snapTo(0f)
                Entrance.progress.animateTo(1f, tween(Entrance.DURATION_MS, easing = LinearEasing))
                Entrance.finish()
            }
        }
    }
    return { Entrance.progress.value }
}

/** One part of the entrance at overall progress [t]: 0 before [startMs], eased to 1 by [endMs]. */
fun entrancePart(t: Float, startMs: Int, endMs: Int): Float {
    if (t >= 1f) return 1f
    val x = ((t * Entrance.DURATION_MS - startMs) / (endMs - startMs)).coerceIn(0f, 1f)
    return EmphasizedDecelerate.transform(x)
}
