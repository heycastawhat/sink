package nz.joshp.sink.ui

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import android.net.Uri
import androidx.compose.material.icons.automirrored.filled.StickyNote2
import androidx.compose.material.icons.automirrored.outlined.StickyNote2
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.Settings
import androidx.navigation.NavType
import androidx.navigation.navArgument
import nz.joshp.sink.BuildConfig
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
    Tab("notes", "Notes", Icons.AutoMirrored.Outlined.StickyNote2, Icons.AutoMirrored.Filled.StickyNote2),
    Tab("todos", "Todos", Icons.Outlined.Checklist, Icons.Filled.Checklist),
    Tab("settings", "Settings", Icons.Outlined.Settings, Icons.Filled.Settings),
)

/** Route for one note (or a new draft when [path] is null, optionally starting with [text]). */
fun noteRoute(path: String?, line: Int? = null, folder: String = "", text: String = "") =
    "note?path=${path?.let(Uri::encode) ?: ""}&line=${line ?: -1}&folder=${Uri.encode(folder)}&text=${Uri.encode(text)}"

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val settings = (application as SinkApp).settings
        val openSettings = intent.getBooleanExtra(EXTRA_OPEN_SETTINGS, false)
        handleSignIn(intent)
        handleDebugSignIn(intent)
        openNote.value = noteTarget(intent)

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

    // A note route from a todo reminder, the New note tile, or text shared from another app.
    private val openNote = mutableStateOf<String?>(null)

    private fun noteTarget(intent: Intent): String? = when {
        intent.action == Intent.ACTION_SEND -> {
            // Shared text becomes a new note: the subject (a page title, say) as its heading.
            val text = intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty().trim()
            val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.trim().orEmpty()
            val body = if (subject.isNotEmpty() && subject != text) "# $subject\n\n$text\n" else if (text.isNotEmpty()) "$text\n" else ""
            body.takeIf { it.isNotEmpty() }?.let { noteRoute(null, text = it) }
        }
        intent.getBooleanExtra(EXTRA_NEW_NOTE, false) -> noteRoute(null)
        intent.getStringExtra(EXTRA_OPEN_NOTE) != null ->
            noteRoute(intent.getStringExtra(EXTRA_OPEN_NOTE), intent.getIntExtra(EXTRA_OPEN_LINE, -1).takeIf { it >= 0 })
        else -> null
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleSignIn(intent)
        handleDebugSignIn(intent)
        noteTarget(intent)?.let { openNote.value = it }
    }

    /**
     * Debug builds only: sign in to a dev server without the OIDC provider, for the emulator:
     * adb shell am start -n nz.joshp.sink/.ui.MainActivity --es debug_server http://10.0.2.2:8799 --es debug_token <token>
     */
    private fun handleDebugSignIn(intent: Intent) {
        if (!BuildConfig.DEBUG) return
        val server = intent.getStringExtra("debug_server") ?: return
        val token = intent.getStringExtra("debug_token") ?: return
        lifecycleScope.launch { (application as SinkApp).settings.saveSession(server, token) }
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
        val notesVm: NotesViewModel = viewModel(key = "notes:" + session.token)
        val nav = rememberNavController()
        val start = remember { if (openSettings) "settings" else "notes" }
        val loggedOut by notesVm.loggedOut.collectAsState()
        LaunchedEffect(loggedOut) { if (loggedOut) settings.clearToken() }
        val noteTarget = openNote.value
        LaunchedEffect(noteTarget) {
            if (noteTarget != null) {
                nav.navigate(noteTarget)
                openNote.value = null
            }
        }

        val entry by nav.currentBackStackEntryAsState()
        val route = entry?.destination?.route
        // A note is its own full-screen page; the tabs keep the bar.
        val showBar = route != null && !route.startsWith("note?")
        val openNoteAt = { path: String, line: Int? -> nav.navigate(noteRoute(path, line)) }

        Scaffold(
            bottomBar = { if (showBar) TabBar(nav, route) },
            containerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
        ) { inner ->
            NavHost(
                nav,
                startDestination = start,
                modifier = Modifier.fillMaxSize().padding(bottom = if (showBar) inner.calculateBottomPadding() else 0.dp),
            ) {
                composable("notes") {
                    NotesScreen(notesVm, onOpen = { openNoteAt(it, null) }, onNew = { nav.navigate(noteRoute(null)) })
                }
                composable("todos") { TodosScreen(notesVm, onOpenNote = { p, l -> openNoteAt(p, l) }) }
                composable(
                    "note?path={path}&line={line}&folder={folder}&text={text}",
                    arguments = listOf(
                        navArgument("path") { type = NavType.StringType; defaultValue = "" },
                        navArgument("line") { type = NavType.IntType; defaultValue = -1 },
                        navArgument("folder") { type = NavType.StringType; defaultValue = "" },
                        navArgument("text") { type = NavType.StringType; defaultValue = "" },
                    ),
                ) { e ->
                    val path = e.arguments?.getString("path").orEmpty().ifEmpty { null }
                    NoteScreen(
                        notesVm,
                        path = path,
                        line = e.arguments?.getInt("line")?.takeIf { it >= 0 },
                        folder = e.arguments?.getString("folder").orEmpty(),
                        serverUrl = session.serverUrl,
                        onBack = { nav.popBackStack() },
                        onOpenNote = { openNoteAt(it, null) },
                        initialText = e.arguments?.getString("text").orEmpty(),
                    )
                }
                composable("settings") { SettingsScreen(settings, notesVm, session.serverUrl) }
            }
        }
    }

    companion object {
        const val EXTRA_OPEN_SETTINGS = "open_settings"
        const val EXTRA_OPEN_NOTE = "open_note"
        const val EXTRA_OPEN_LINE = "open_line"
        const val EXTRA_NEW_NOTE = "new_note"
        private val Loading = Session("", "")
    }
}

@Composable
private fun TabBar(nav: NavHostController, selected: String?) {
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
                icon = { Icon(if (on) t.selectedIcon else t.icon, null) },
                label = { Text(t.label) },
            )
        }
    }
}
