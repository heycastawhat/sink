package nz.joshp.sink.ui

import android.widget.EditText
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.staggeredgrid.LazyVerticalStaggeredGrid
import androidx.compose.foundation.lazy.staggeredgrid.StaggeredGridCells
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.viewinterop.AndroidView
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class NavigationFocusTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun popClearsNativeFocusBeforeRemovingTheEditor() = checkNavigation { it.popBackStack() }

    @Test
    fun openingAnotherDestinationClearsNativeFocus() = checkNavigation { it.navigate("other") }

    private fun checkNavigation(navigate: (NavHostController) -> Unit) {
        lateinit var nav: NavHostController
        lateinit var editor: EditText
        compose.setContent {
            nav = rememberNavController()
            ClearFocusOnNavigation(nav)
            NavHost(nav, startDestination = "grid") {
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
        }
        compose.runOnIdle { nav.navigate("editor") }
        compose.waitForIdle()
        compose.runOnIdle {
            assertTrue(editor.requestFocus())
            assertTrue(editor.hasFocus())
            navigate(nav)
            // The destination is still composed here: disposal is too late to release View focus.
            assertFalse(editor.hasFocus())
        }
        compose.waitForIdle()
    }
}
