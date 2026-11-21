package nz.joshp.sink.ui

import android.view.View
import android.view.ViewGroup
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalView
import androidx.navigation.NavController

internal fun clearViewFocus(view: View?, focus: FocusManager) {
    val root = view?.rootView as? ViewGroup
    val descendants = root?.descendantFocusability
    try {
        // Keep Android's initial-focus search from focusing a Compose text field as the View lets go.
        root?.descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
        view?.findFocus()?.clearFocus()
        focus.clearFocus(force = true)
    } finally {
        if (root != null && descendants != null) root.descendantFocusability = descendants
    }
}

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
                clearViewFocus(view, focus)
            }
            previous = current
        }
        nav.addOnDestinationChangedListener(listener)
        onDispose { nav.removeOnDestinationChangedListener(listener) }
    }
}
