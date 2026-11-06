package nz.joshp.sink.ui

import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.BoundsTransform
import androidx.compose.animation.EnterExitState
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.animation.core.animateDp
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp

/**
 * Shrinks a tappable card a touch while it's pressed and springs it back, with the theme's expressive motion.
 * Share one [MutableInteractionSource] with the card's `clickable` (and its indication) so both see the same press;
 * put this first in the chain, before `clip`, so the whole card scales.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun Modifier.pressScale(source: InteractionSource, pressedScale: Float = 0.97f): Modifier {
    val pressed by source.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) pressedScale else 1f, MaterialTheme.motionScheme.fastSpatialSpec(), label = "press")
    return graphicsLayer {
        scaleX = scale
        scaleY = scale
    }
}

/**
 * A tapped card grows into the note it opens, and the note shrinks back into it on the way out (following a predictive
 * back gesture, since the NavHost seeks its transition with it). Only provided on phones: beside the list nothing moves.
 */
class CardMorph(val shared: SharedTransitionScope) {
    /**
     * The card just tapped, taken by the navigation that opens its note. Keys name the card, not just the note: a note
     * can show in Recent and the grid at once, and the note has to shrink back into the one it came from.
     */
    var tapped: String? = null

    fun take() = tapped.also { tapped = null }
}

val LocalCardMorph = staticCompositionLocalOf<CardMorph?> { null }

/** The current destination's side of the NavHost transition, for the shared bounds on it. */
val LocalNavScope = staticCompositionLocalOf<AnimatedVisibilityScope?> { null }

/**
 * One end of a card morph: the bounds a card and its note share, resized (not scaled) so backgrounds drawn after this
 * fill them. With no match (the card's gone, or the note came from search or a link) it does nothing and the
 * NavHost's own transition plays. [note] is the note's end: its corners round off towards the card's.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun Modifier.morphBounds(key: String?, note: Boolean = false): Modifier {
    val morph = LocalCardMorph.current
    val nav = LocalNavScope.current
    if (key == null || morph == null || nav == null) return this
    val motion = MaterialTheme.motionScheme
    val corner = if (note) {
        nav.transition.animateDp({ motion.defaultSpatialSpec() }, label = "morph-corner") {
            if (it == EnterExitState.Visible) 0.dp else 16.dp
        }.value
    } else 16.dp
    return with(morph.shared) {
        this@morphBounds.sharedBounds(
            rememberSharedContentState(key),
            nav,
            enter = fadeIn(motion.defaultEffectsSpec()),
            exit = fadeOut(motion.fastEffectsSpec()),
            boundsTransform = BoundsTransform { _, _ -> motion.defaultSpatialSpec() },
            resizeMode = SharedTransitionScope.ResizeMode.RemeasureToBounds,
            clipInOverlayDuringTransition = OverlayClip(RoundedCornerShape(corner)),
        )
    }
}

/** Inside a note's [morphBounds]: lays the page out at its full size while the bounds grow, so it doesn't reflow. */
@Composable
fun Modifier.morphContent(): Modifier {
    val morph = LocalCardMorph.current ?: return this
    return with(morph.shared) { this@morphContent.skipToLookaheadSize() }
}
