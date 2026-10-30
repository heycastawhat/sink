package nz.joshp.sink.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer

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
