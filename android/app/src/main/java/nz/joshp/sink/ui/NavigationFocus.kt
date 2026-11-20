package nz.joshp.sink.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalView
import androidx.navigation.NavController

@Composable
internal fun ClearFocusOnNavigation(nav: NavController) {
    val view = LocalView.current
    val focus = LocalFocusManager.current
    DisposableEffect(nav, view, focus) {
        var previous = nav.currentBackStackEntry
        val listener = NavController.OnDestinationChangedListener { controller, _, _ ->
            val current = controller.currentBackStackEntry
            if (previous != null && previous != current) {
                // Focus recovery during AndroidView detach can remeasure the lazy grid mid-apply.
                view.findFocus()?.clearFocus()
                focus.clearFocus(force = true)
            }
            previous = current
        }
        nav.addOnDestinationChangedListener(listener)
        onDispose { nav.removeOnDestinationChangedListener(listener) }
    }
}
