package nz.joshp.sink.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.lerp
import androidx.compose.ui.unit.offset
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/** A place in the [FloatingNavBar]. */
data class NavPlace(val route: String, val label: String, val icon: ImageVector, val selectedIcon: ImageVector)

/**
 * The tabs as a compact floating pill, only as wide as its places: the open one is a capsule round its icon and name,
 * the others icons alone. On a switch the new capsule widens (its drawn width springing a little past and settling)
 * and its name fades in once there's room, while the old one's name goes at once and its capsule folds away; the
 * icon pops as its place opens and presses dip. Each place is a tab whose accessible name is its label.
 */
@Composable
fun FloatingNavBar(
    places: List<NavPlace>,
    selected: String?,
    badges: Map<String, Int>,
    onSelect: (NavPlace) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = navBarColors()
    Row(
        modifier
            .height(TOOLBAR_HEIGHT)
            .shadow(8.dp, CircleShape, ambientColor = Color.Black, spotColor = Color.Black)
            .background(colors.container, CircleShape)
            .padding(PILL_GAP)
            .selectableGroup(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(PILL_GAP),
    ) {
        for (p in places) NavPlaceItem(p, p.route == selected, badges[p.route] ?: 0, colors) { onSelect(p) }
    }
}

/** The one gap in the pill: round its edge and between its places alike. */
private val PILL_GAP = 6.dp
/** The open place's capsule: this much either side of its icon and name. */
private val CAPSULE_PADDING = 20.dp
/** An icon-only place is a circle, as wide as the pill is tall inside its gap. */
private val ITEM_WIDTH = TOOLBAR_HEIGHT - PILL_GAP * 2

/** The springs: the place opening without overshoot (so the pill never bulges past where it lands), the drawn capsule with it. */
private object NavMotion {
    const val POP_FROM = 0.84f
    val Pop = spring<Float>(dampingRatio = 0.42f, stiffness = 380f)
    val Grow = spring<Float>(dampingRatio = 1f, stiffness = 420f)
    val Bounce = spring<Float>(dampingRatio = 0.6f, stiffness = 420f)
    val Fold = spring<Float>(dampingRatio = 1f, stiffness = 600f)
    val PressDown = tween<Float>(90, easing = FastOutSlowInEasing)
    val PressUp = spring<Float>(dampingRatio = 0.45f, stiffness = 420f)
}

@Composable
private fun NavPlaceItem(place: NavPlace, selected: Boolean, badge: Int, colors: NavBarColors, onClick: () -> Unit) {
    val colorSpec = spring<Color>(stiffness = Spring.StiffnessMediumLow)
    val capsule by animateColorAsState(if (selected) colors.indicator else colors.indicator.copy(alpha = 0f), colorSpec, label = "nav-capsule")
    val content by animateColorAsState(if (selected) colors.selected else colors.unselected, colorSpec, label = "nav-content")
    // How open the place is: drives the layout without overshoot, while the capsule's drawn width follows [bounce].
    val open = remember { Animatable(if (selected) 1f else 0f) }
    val bounce = remember { Animatable(if (selected) 1f else 0f) }
    val iconPop = remember { Animatable(1f) }
    val wasSelected = remember { booleanArrayOf(selected) }
    LaunchedEffect(selected) {
        val became = selected && !wasSelected[0]
        wasSelected[0] = selected
        val target = if (selected) 1f else 0f
        launch { open.animateTo(target, if (selected) NavMotion.Grow else NavMotion.Fold) }
        launch { bounce.animateTo(target, if (selected) NavMotion.Bounce else NavMotion.Fold) }
        if (became) {
            iconPop.snapTo(NavMotion.POP_FROM)
            iconPop.animateTo(1f, NavMotion.Pop)
        } else if (iconPop.value != 1f) iconPop.animateTo(1f, NavMotion.Fold)
    }
    // The press dips the icon and name (never the capsule), and a quick tap still shows the whole dip.
    val interactions = remember { MutableInteractionSource() }
    val press = remember { Animatable(1f) }
    LaunchedEffect(interactions) {
        var down: kotlinx.coroutines.Job? = null
        var up: kotlinx.coroutines.Job? = null
        interactions.interactions.collect { i ->
            when (i) {
                is PressInteraction.Press -> {
                    up?.cancel()
                    down = launch { press.animateTo(0.9f, NavMotion.PressDown) }
                }
                is PressInteraction.Release, is PressInteraction.Cancel -> {
                    val pressing = down
                    up = launch {
                        pressing?.join()
                        press.animateTo(1f, NavMotion.PressUp)
                    }
                }
            }
        }
    }
    val labelAlpha by animateFloatAsState(
        if (selected) 1f else 0f,
        if (selected) tween(160, delayMillis = 90) else tween(70),
        label = "nav-label",
    )
    val showLabel by remember { derivedStateOf { open.value > 0f || labelAlpha > 0f } }
    val cellPadding = (ITEM_WIDTH - 24.dp) / 2
    val labelRoomPx = remember { floatArrayOf(0f) }
    Row(
        Modifier
            .fillMaxHeight()
            // The capsule, drawn unclipped and wider than the place by the bounce's lead on the layout, so it
            // overshoots and settles while the place itself doesn't (at most the pill's gap each way).
            .drawBehind {
                val most = PILL_GAP.toPx() * 2
                val extra = ((bounce.value - open.value) * (labelRoomPx[0] + 2 * (CAPSULE_PADDING - cellPadding).toPx())).coerceIn(-most, most)
                val width = (size.width + extra).coerceAtLeast(0f)
                drawRoundRect(capsule, topLeft = Offset((size.width - width) / 2f, 0f), size = Size(width, size.height), cornerRadius = CornerRadius(size.height / 2f))
            }
            .clip(CircleShape)
            .selectable(selected = selected, onClick = onClick, role = Role.Tab, interactionSource = interactions, indication = ripple())
            .semantics { contentDescription = if (badge > 0) "${place.label}, $badge due" else place.label }
            .layout { measurable, constraints ->
                // Side padding goes from the icon cell's to the capsule's as the place opens.
                val pad = lerp(cellPadding, CAPSULE_PADDING, open.value.coerceIn(0f, 1f)).roundToPx()
                val placeable = measurable.measure(constraints.offset(horizontal = -pad * 2))
                layout(placeable.width + pad * 2, placeable.height) { placeable.place(pad, 0) }
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(Modifier.graphicsLayer { scaleX = press.value; scaleY = press.value }, verticalAlignment = Alignment.CenterVertically) {
            // Todos: how many are overdue or due today.
            BadgedBox(badge = { if (badge > 0) Badge { Text(if (badge > 99) "99+" else "$badge") } }) {
                Icon(
                    if (selected) place.selectedIcon else place.icon,
                    null,
                    tint = content,
                    modifier = Modifier.size(24.dp).graphicsLayer { scaleX = iconPop.value; scaleY = iconPop.value },
                )
            }
            if (selected || showLabel) {
                Row(
                    Modifier
                        .clipToBounds()
                        .layout { measurable, constraints ->
                            // Laid out at full width, shown as much as the place is open.
                            val placeable = measurable.measure(constraints.copy(minWidth = 0))
                            labelRoomPx[0] = placeable.width.toFloat()
                            val shown = (placeable.width * open.value.coerceIn(0f, 1f)).roundToInt()
                            layout(shown, placeable.height) { placeable.placeRelative(0, 0) }
                        }
                        .graphicsLayer { alpha = labelAlpha },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Spacer(Modifier.width(8.dp))
                    Text(
                        place.label,
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.SemiBold,
                        color = content,
                        maxLines = 1,
                        modifier = Modifier.clearAndSetSemantics { },
                    )
                }
            }
        }
    }
}

private class NavBarColors(val container: Color, val indicator: Color, val selected: Color, val unselected: Color)

/**
 * A pill a little tinted towards the primary container, the open place's capsule stronger still (the full primary
 * container in a light theme, so it stands clear of the pale pill), its content in the primary colour (dark) or on it.
 */
@Composable
private fun navBarColors(): NavBarColors {
    val s = MaterialTheme.colorScheme
    val dark = s.surface.luminance() < 0.5f
    return NavBarColors(
        container = lerp(if (dark) s.surfaceContainer else s.surfaceContainerHigh, s.primaryContainer, if (dark) 0.3f else 0.2f),
        indicator = if (dark) lerp(s.surfaceContainerHighest, s.primaryContainer, 0.85f) else s.primaryContainer,
        selected = if (dark) s.primary else s.onPrimaryContainer,
        unselected = s.onSurfaceVariant,
    )
}
