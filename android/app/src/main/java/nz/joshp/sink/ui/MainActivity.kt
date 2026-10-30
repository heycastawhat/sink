package nz.joshp.sink.ui

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.draw.clip
import androidx.compose.ui.Alignment
import androidx.compose.material3.Surface
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
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
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.repeatOnLifecycle
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import nz.joshp.sink.SinkApp
import nz.joshp.sink.capture.SharedFiles
import nz.joshp.sink.data.Update
import nz.joshp.sink.data.Updates
import nz.joshp.sink.data.Session
import nz.joshp.sink.data.SignIn
import nz.joshp.sink.ui.theme.SinkTheme
import java.io.File

private data class Tab(val route: String, val label: String, val icon: ImageVector, val selectedIcon: ImageVector)

private val TABS = listOf(
    Tab("notes", "Notes", Icons.AutoMirrored.Outlined.StickyNote2, Icons.AutoMirrored.Filled.StickyNote2),
    Tab("todos", "Todos", Icons.Outlined.Checklist, Icons.Filled.Checklist),
    Tab("settings", "Settings", Icons.Outlined.Settings, Icons.Filled.Settings),
)

/**
 * Route for one note (or a new draft when [path] is null, optionally starting with [text] and with [files] from the
 * app's cache to attach).
 */
fun noteRoute(path: String?, line: Int? = null, folder: String = "", text: String = "", files: List<File> = emptyList()) =
    "note?path=${path?.let(Uri::encode) ?: ""}&line=${line ?: -1}&folder=${Uri.encode(folder)}&text=${Uri.encode(text)}" +
        "&files=${Uri.encode(files.joinToString("\n") { it.path })}"

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val settings = (application as SinkApp).settings
        val openSettings = intent.getBooleanExtra(EXTRA_OPEN_SETTINGS, false)
        handleSignIn(intent)
        handleDebugSignIn(intent)
        openNote.value = noteTarget(intent)
        // Not again when the activity is recreated (rotation): the files were already copied and opened.
        if (savedInstanceState == null) handleSharedFiles(intent)

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

    // A note route from a todo reminder, the New note tile, or text and files shared from another app.
    private val openNote = mutableStateOf<String?>(null)

    private fun noteTarget(intent: Intent): String? = when {
        SharedFiles.uris(intent).isNotEmpty() -> null
        intent.action == Intent.ACTION_SEND -> {
            sharedText(intent).takeIf { it.isNotEmpty() }?.let { noteRoute(null, text = it) }
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
        handleSharedFiles(intent)
    }

    /** Shared text: the subject (a page title, say) as its heading. */
    private fun sharedText(intent: Intent): String {
        val text = intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty().trim()
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.trim().orEmpty()
        return if (subject.isNotEmpty() && subject != text) "# $subject\n\n$text\n" else if (text.isNotEmpty()) "$text\n" else ""
    }

    /** Photos and PDFs shared in: copied while we may still read them, then a new note that attaches them. */
    private fun handleSharedFiles(intent: Intent) {
        val uris = SharedFiles.uris(intent)
        if (uris.isEmpty()) return
        val text = sharedText(intent)
        lifecycleScope.launch {
            val files = withContext(Dispatchers.IO) { SharedFiles.copy(applicationContext, uris) }
            if (files.isNotEmpty() || text.isNotEmpty()) openNote.value = noteRoute(null, text = text, files = files)
        }
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
        // Live changes from the server while the app is on screen; stopped in the background to save battery.
        val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
        LaunchedEffect(notesVm, lifecycle) {
            lifecycle.repeatOnLifecycle(androidx.lifecycle.Lifecycle.State.STARTED) { notesVm.listen() }
        }
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

        // A newer APK on GitHub: asked about once a day, or from Settings.
        var update by remember { mutableStateOf<Update?>(null) }
        LaunchedEffect(Unit) {
            if (BuildConfig.DEBUG || System.currentTimeMillis() - settings.updateCheckedAt() < Updates.DAY_MS) return@LaunchedEffect
            val found = runCatching { Updates.check(BuildConfig.VERSION_NAME) }.getOrElse { return@LaunchedEffect }
            settings.setUpdateCheckedAt(System.currentTimeMillis())
            if (found != null && found.version != settings.skippedVersion()) update = found
        }
        val checkForUpdates: suspend () -> String? = {
            runCatching { Updates.check(BuildConfig.VERSION_NAME) }.fold(
                onSuccess = { found ->
                    settings.setUpdateCheckedAt(System.currentTimeMillis())
                    update = found
                    if (found == null) "You have the latest version" else null
                },
                onFailure = { "Couldn't check: ${it.message}" },
            )
        }
        update?.let { u ->
            UpdateDialog(
                u,
                onDownload = {
                    update = null
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(u.apkUrl)))
                },
                onSkip = {
                    update = null
                    lifecycleScope.launch { settings.skipVersion(u.version) }
                },
                onLater = { update = null },
            )
        }

        Scaffold(
            containerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
        ) { _ ->
          Box(Modifier.fillMaxSize()) {
            // Screens draw to the bottom edge; the tabs float over them (each screen leaves room, see toolbarClearance).
            NavHost(
                nav,
                startDestination = start,
                modifier = Modifier.fillMaxSize(),
            ) {
                composable("notes") {
                    NotesScreen(notesVm, onOpen = { openNoteAt(it, null) }, onNew = { nav.navigate(noteRoute(null, folder = notesVm.state.value.folder)) })
                }
                composable("todos") { TodosScreen(notesVm, onOpenNote = { p, l -> openNoteAt(p, l) }) }
                composable(
                    "note?path={path}&line={line}&folder={folder}&text={text}&files={files}",
                    arguments = listOf(
                        navArgument("path") { type = NavType.StringType; defaultValue = "" },
                        navArgument("line") { type = NavType.IntType; defaultValue = -1 },
                        navArgument("folder") { type = NavType.StringType; defaultValue = "" },
                        navArgument("text") { type = NavType.StringType; defaultValue = "" },
                        navArgument("files") { type = NavType.StringType; defaultValue = "" },
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
                        sharedFiles = e.arguments?.getString("files").orEmpty().split('\n').filter { it.isNotEmpty() }.map(::File),
                    )
                }
                composable("settings") { SettingsScreen(settings, notesVm, session.serverUrl, onCheckForUpdates = checkForUpdates) }
            }
            if (showBar) {
                FloatingTabs(
                    nav,
                    route,
                    Modifier.align(Alignment.BottomStart).navigationBarsPadding().padding(start = 16.dp, bottom = TOOLBAR_BOTTOM),
                )
            }
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

/**
 * The tabs as a floating toolbar (Material 3 Expressive), bottom left where a thumb rests, with each screen's + button
 * beside it on the right. The open tab shows its name; the others are icons.
 */
@Composable
private fun FloatingTabs(nav: NavHostController, selected: String?, modifier: Modifier = Modifier) {
    Surface(
        shape = CircleShape,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shadowElevation = 6.dp,
        modifier = modifier.height(TOOLBAR_HEIGHT),
    ) {
        Row(Modifier.padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            for (t in TABS) {
                val on = selected == t.route
                Row(
                    Modifier
                        .height(48.dp)
                        .clip(CircleShape)
                        .background(if (on) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent)
                        .clickable {
                            nav.navigate(t.route) {
                                // Tabs keep one copy each and remember where you were in them.
                                popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                                launchSingleTop = true
                                restoreState = true
                            }
                        }
                        .padding(horizontal = if (on) 16.dp else 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        if (on) t.selectedIcon else t.icon,
                        if (on) null else t.label,
                        tint = if (on) MaterialTheme.colorScheme.onSecondaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (on) {
                        Spacer(Modifier.width(8.dp))
                        Text(t.label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSecondaryContainer)
                    }
                }
            }
        }
    }
}
