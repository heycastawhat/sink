package nz.joshp.sink.ui

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import kotlinx.coroutines.launch
import nz.joshp.sink.SinkApp
import nz.joshp.sink.data.Session
import nz.joshp.sink.data.SignIn
import nz.joshp.sink.ui.theme.SinkTheme

private data class Tab(val route: String, val label: String, val icon: ImageVector, val selectedIcon: ImageVector)

private val TABS = listOf(
    Tab("home", "Sink", Icons.Outlined.Inventory2, Icons.Filled.Inventory2),
    Tab("review", "Review", Icons.Outlined.AutoAwesome, Icons.Filled.AutoAwesome),
    Tab("library", "Library", Icons.Outlined.Folder, Icons.Filled.Folder),
    Tab("settings", "Settings", Icons.Outlined.Settings, Icons.Filled.Settings),
)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val settings = (application as SinkApp).settings
        val openSettings = intent.getBooleanExtra(EXTRA_OPEN_SETTINGS, false)
        handleSignIn(intent)
        openCapture.value = intent.getStringExtra(EXTRA_OPEN_CAPTURE)

        setContent {
            val dynamic by settings.dynamicColor.collectAsState(initial = false)
            val mode by settings.themeMode.collectAsState(initial = "auto")
            // Sentinel distinguishes "still loading" from "logged out" so login doesn't flash.
            val session by settings.session.collectAsState(initial = Loading)
            val lastServer by settings.lastServerUrl.collectAsState(initial = null)

            SinkTheme(dynamicColor = dynamic, mode = mode) {
                when (val s = session) {
                    Loading -> Unit
                    null -> LoginScreen(settings, lastServer, signingIn.value, signInError.value)
                    else -> LoggedIn(s, openSettings)
                }
            }
        }
    }

    private val signingIn = mutableStateOf(false)
    private val signInError = mutableStateOf<String?>(null)

    // Set by reminder notifications and the widget; LoggedIn navigates to it.
    private val openCapture = mutableStateOf<String?>(null)

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleSignIn(intent)
        intent.getStringExtra(EXTRA_OPEN_CAPTURE)?.let { openCapture.value = it }
    }

    private fun handleSignIn(intent: Intent) {
        val uri = intent.data
        if (!SignIn.isCallback(uri)) return
        signingIn.value = true
        signInError.value = null
        lifecycleScope.launch {
            signInError.value = SignIn.complete((application as SinkApp).settings, uri!!)
            signingIn.value = false
        }
    }

    @Composable
    private fun LoggedIn(session: Session, openSettings: Boolean) {
        val settings = (application as SinkApp).settings
        CaptureImages.base = session.serverUrl
        val vm: SinkViewModel = viewModel(key = session.token)
        val nav = rememberNavController()
        val start = remember { if (openSettings) "settings" else "home" }
        val loggedOut by vm.loggedOut.collectAsState()
        LaunchedEffect(loggedOut) { if (loggedOut) settings.clearToken() }
        val target = openCapture.value
        LaunchedEffect(target) {
            if (target != null) {
                nav.navigate("capture/$target")
                openCapture.value = null
            }
        }

        val entry by nav.currentBackStackEntryAsState()
        val route = entry?.destination?.route
        // Captures are their own full-screen page; everything else keeps the tab bar.
        val showBar = route != null && !route.startsWith("capture/")
        val tab = when {
            route == null -> null
            route.startsWith("view/") || route.startsWith("collection/") -> "library"
            else -> route
        }
        val open = { id: String -> nav.navigate("capture/$id") }

        Scaffold(
            bottomBar = { if (showBar) TabBar(nav, tab, vm) },
            containerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
        ) { inner ->
            NavHost(
                nav,
                startDestination = start,
                modifier = Modifier.fillMaxSize().padding(bottom = if (showBar) inner.calculateBottomPadding() else 0.dp),
            ) {
                composable("home") { HomeScreen(vm, session.serverUrl, View.All, onOpen = open) }
                composable("review") { HomeScreen(vm, session.serverUrl, View.Review, onOpen = open) }
                composable("library") {
                    LibraryScreen(
                        vm,
                        onView = { nav.navigate("view/${it.id}") },
                        onCollection = { nav.navigate("collection/$it") },
                    )
                }
                composable("view/{id}") { e ->
                    val view = View.entries.firstOrNull { it.id == e.arguments?.getString("id") } ?: View.Pinned
                    HomeScreen(vm, session.serverUrl, view, onOpen = open, onBack = { nav.popBackStack() })
                }
                composable("collection/{id}") { e ->
                    HomeScreen(vm, session.serverUrl, View.All, e.arguments?.getString("id"), onOpen = open, onBack = { nav.popBackStack() })
                }
                composable("settings") { SettingsScreen(settings, vm, session.serverUrl) }
                composable("capture/{id}") { e ->
                    DetailScreen(vm, e.arguments?.getString("id")!!, onBack = { nav.popBackStack() })
                }
            }
        }
    }

    companion object {
        const val EXTRA_OPEN_SETTINGS = "open_settings"
        const val EXTRA_OPEN_CAPTURE = "open_capture"
        private val Loading = Session("", "")
    }
}

@Composable
private fun TabBar(nav: NavHostController, selected: String?, vm: SinkViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    NavigationBar(containerColor = MaterialTheme.colorScheme.surfaceContainer) {
        for (t in TABS) {
            val on = selected == t.route
            NavigationBarItem(
                selected = on,
                onClick = {
                    nav.navigate(t.route) {
                        // Tabs keep one copy each and remember where you were in them.
                        popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                        launchSingleTop = true
                        restoreState = true
                    }
                },
                icon = {
                    BadgedBox(badge = { if (t.route == "review" && state.reviewCount > 0) Badge { Text("${state.reviewCount}") } }) {
                        Icon(if (on) t.selectedIcon else t.icon, null)
                    }
                },
                label = { Text(t.label) },
            )
        }
    }
}
