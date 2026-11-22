package nz.joshp.sink.ui

import android.view.ViewGroup
import android.widget.EditText
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.staggeredgrid.LazyVerticalStaggeredGrid
import androidx.compose.foundation.lazy.staggeredgrid.StaggeredGridCells
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.viewinterop.AndroidView
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class NavigationFocusTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun popClearsNativeFocusBeforeRemovingTheEditor() = checkNavigation { it.popBackStack() }

    @Test
    fun openingAnotherDestinationClearsNativeFocus() = checkNavigation { it.navigate("other") }

    @Test
    fun clearingWithoutAViewStillClearsComposeFocus() {
        var forced = false
        clearViewFocus(null, focusManager { forced = it })
        assertTrue(forced)
    }

    @Test
    fun windowFocusPolicyIsRestoredIfClearingFails() {
        lateinit var root: ViewGroup
        compose.setContent { root = LocalView.current.rootView as ViewGroup }
        compose.runOnIdle {
            val descendants = root.descendantFocusability
            assertThrows(IllegalStateException::class.java) {
                clearViewFocus(root, focusManager { throw IllegalStateException("Failed to clear focus") })
            }
            assertEquals(descendants, root.descendantFocusability)
        }
    }

    private fun focusManager(clear: (Boolean) -> Unit) = object : FocusManager {
        override fun clearFocus(force: Boolean) = clear(force)
        override fun moveFocus(focusDirection: FocusDirection) = false
    }

    private fun checkNavigation(navigate: (NavHostController) -> Unit) {
        lateinit var nav: NavHostController
        lateinit var editor: EditText
        compose.setContent {
            nav = rememberNavController()
            ClearFocusOnNavigation(nav)
            Column(Modifier.fillMaxSize()) {
                NavHost(nav, startDestination = "grid", modifier = Modifier.weight(1f)) {
                    composable("grid") {
                        LazyVerticalStaggeredGrid(StaggeredGridCells.Fixed(2), Modifier.fillMaxSize()) {
                            items(30) { Text("Note $it") }
                        }
                    }
                    composable("editor") {
                        AndroidView(factory = { EditText(it).also { view -> editor = view } })
                    }
                    composable("other") { Text("Other note") }
                }
                TextField(value = "", onValueChange = {}, modifier = Modifier.testTag("search"))
            }
        }
        compose.runOnIdle { nav.navigate("editor") }
        compose.waitForIdle()
        compose.runOnIdle {
            val root = editor.rootView as ViewGroup
            val descendants = root.descendantFocusability
            assertTrue(editor.requestFocus())
            assertTrue(editor.hasFocus())
            navigate(nav)
            // The destination is still composed here: disposal is too late to release View focus.
            assertFalse(editor.hasFocus())
            assertEquals(descendants, root.descendantFocusability)
        }
        compose.waitForIdle()
        compose.onNodeWithTag("search").assertIsNotFocused()
    }
}
