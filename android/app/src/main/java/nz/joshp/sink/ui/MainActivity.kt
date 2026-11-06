package nz.joshp.sink.ui

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.view.ViewTreeObserver
import android.view.animation.AccelerateInterpolator
import android.view.animation.DecelerateInterpolator
import androidx.annotation.RequiresApi
import androidx.compose.ui.graphics.graphicsLayer
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.draw.clip
import androidx.compose.ui.Alignment
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Surface
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.material3.VerticalDivider
import androidx.compose.material.icons.outlined.EditNote
import androidx.compose.runtime.key
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.animation.SharedTransitionLayout
import androidx.navigationevent.NavigationEventTransitionState
import androidx.navigationevent.compose.LocalNavigationEventDispatcherOwner
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.ui.unit.IntSize
import androidx.compose.foundation.background
import androidx.compose.material.icons.Icons
import android.net.Uri
import androidx.compose.material.icons.automirrored.filled.StickyNote2
import androidx.compose.material.icons.automirrored.outlined.StickyNote2
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.outlined.Checklist
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
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import nz.joshp.sink.SinkApp
import nz.joshp.sink.capture.SharedFiles
import nz.joshp.sink.data.Api
import nz.joshp.sink.data.Update
import nz.joshp.sink.data.Updates
import nz.joshp.sink.data.Session
import nz.joshp.sink.data.clipUrl
import nz.joshp.sink.data.SignIn
import nz.joshp.sink.ui.theme.SinkTheme
import java.io.File

private val TABS = listOf(
    NavPlace("notes", "Notes", Icons.AutoMirrored.Outlined.StickyNote2, Icons.AutoMirrored.Filled.StickyNote2),
    NavPlace("todos", "Todos", Icons.Outlined.Checklist, Icons.Filled.Checklist),
)

/**
 * A note to open (or a new draft when [path] is null, optionally starting with [text] and with [files] from the
 * app's cache to attach). [opened] tells two otherwise identical new drafts apart. [from] is the card it was opened
 * from, which it grows out of (see [CardMorph]).
 */
data class NoteTarget(
    val path: String?,
    val line: Int? = null,
    val folder: String = "",
    val text: String = "",
    val files: List<File> = emptyList(),
    val opened: Long = System.nanoTime(),
    val from: String? = null,
) {
    val route get() =
        "note?path=${path?.let(Uri::encode) ?: ""}&line=${line ?: -1}&folder=${Uri.encode(folder)}&text=${Uri.encode(text)}" +
            "&files=${Uri.encode(files.joinToString("\n") { it.path })}&from=${Uri.encode(from.orEmpty())}"
}

private val NoteTargetSaver = listSaver<NoteTarget?, String>(
    save = { t -> if (t == null) emptyList() else listOf(t.path ?: "\u0000", "${t.line ?: -1}", t.folder, t.text, t.files.joinToString("\n") { it.path }, "${t.opened}", t.from.orEmpty()) },
    restore = { v ->
        if (v.isEmpty()) null
        else NoteTarget(
            v[0].takeIf { it != "\u0000" }, v[1].toInt().takeIf { it >= 0 }, v[2], v[3],
            v[4].split('\n').filter { it.isNotEmpty() }.map(::File), v[5].toLong(), v.getOrNull(6)?.ifEmpty { null },
        )
    },
)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // A fresh start has the system splash to lift away (and an entrance to play under it); a recreation has neither.
        if (savedInstanceState == null && Build.VERSION.SDK_INT >= 31) holdSplash() else Entrance.finish()
        val settings = (application as SinkApp).settings
        val openSettings = intent.getBooleanExtra(EXTRA_OPEN_SETTINGS, false)
        handleSignIn(intent)
        handleDebugSignIn(intent)
        openNote.value = noteTarget(intent)
        // Not again when the activity is recreated (rotation): the files were already copied and opened.
        if (savedInstanceState == null) {
            handleSharedFiles(intent)
            handleSharedLink(intent)
        }

        setContent {
            val dynamic by settings.dynamicColor.collectAsState(initial = false)
            val mode by settings.themeMode.collectAsState(initial = "auto")
            // Sentinel distinguishes "still loading" from "logged out" so login doesn't flash.
            val session by settings.session.collectAsState(initial = Loading)
            val lastServer by settings.lastServerUrl.collectAsState(initial = null)

            SinkTheme(dynamicColor = dynamic, mode = mode) {
                if (session != Loading) firstScreenReady = true
                when (val s = session) {
                    Loading -> Unit
                    null -> LoginScreen(settings, lastServer, signingIn.value, signInError.value)
                    else -> LoggedIn(s, openSettings)
                }
            }
        }
    }

    /** Whether we know yet who's signed in, so the splash can go to a real screen rather than a blank one. */
    @Volatile private var firstScreenReady = false

    /**
     * Keeps the splash up until its drop has landed (and we know which screen to show, for [SPLASH_MAX_MS] at most),
     * then lifts it away: the drop swells as it fades and the splash clears as the app's entrance plays ([Entrance]).
     */
    @RequiresApi(31)
    private fun holdSplash() {
        val now = SystemClock.uptimeMillis()
        // The drop starts falling as the splash window goes up, which for a cold start is about when the process did.
        val processStart = android.os.Process.getStartUptimeMillis()
        val start = if (now - processStart < SPLASH_MIN_MS) processStart else now
        val content = findViewById<View>(android.R.id.content)
        content.viewTreeObserver.addOnPreDrawListener(object : ViewTreeObserver.OnPreDrawListener {
            override fun onPreDraw(): Boolean {
                val shown = SystemClock.uptimeMillis() - start
                if (!(firstScreenReady && shown >= SPLASH_MIN_MS) && shown < SPLASH_MAX_MS) return false
                content.viewTreeObserver.removeOnPreDrawListener(this)
                return true
            }
        })
        splashScreen.setOnExitAnimationListener { view ->
            Entrance.hide()
            view.iconView?.animate()
                ?.scaleX(1.6f)?.scaleY(1.6f)?.alpha(0f)
                ?.setDuration(320)
                ?.setInterpolator(AccelerateInterpolator(1.5f))
                ?.start()
            view.animate()
                .alpha(0f)
                .setStartDelay(80)
                .setDuration(300)
                .setInterpolator(DecelerateInterpolator())
                .withEndAction { view.remove() }
                .start()
            // Once the splash has started to clear, so the entrance is seen.
            view.postDelayed({ Entrance.play() }, 80)
        }
    }

    private val signingIn = mutableStateOf(false)
    private val signInError = mutableStateOf<String?>(null)

    // A note route from a todo reminder, the New note tile, or text and files shared from another app.
    private val openNote = mutableStateOf<NoteTarget?>(null)

    // The quick switcher, open over whatever screen is showing.
    private val switching = mutableStateOf(false)

    /** Ctrl+K (or Ctrl+O, as in Obsidian) with a keyboard attached: the quick switcher, from anywhere, even mid-note. */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN && (event.isCtrlPressed || event.isMetaPressed) &&
            (event.keyCode == KeyEvent.KEYCODE_K || event.keyCode == KeyEvent.KEYCODE_O)
        ) {
            switching.value = true
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun noteTarget(intent: Intent): NoteTarget? = when {
        SharedFiles.uris(intent).isNotEmpty() || sharedLink(intent) != null -> null
        intent.action == Intent.ACTION_SEND -> {
            sharedText(intent).takeIf { it.isNotEmpty() }?.let { NoteTarget(null, text = it) }
        }
        intent.getBooleanExtra(EXTRA_NEW_NOTE, false) -> NoteTarget(null)
        intent.getStringExtra(EXTRA_OPEN_NOTE) != null ->
            NoteTarget(intent.getStringExtra(EXTRA_OPEN_NOTE), intent.getIntExtra(EXTRA_OPEN_LINE, -1).takeIf { it >= 0 })
        else -> null
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleSignIn(intent)
        handleDebugSignIn(intent)
        noteTarget(intent)?.let { openNote.value = it }
        handleSharedFiles(intent)
        handleSharedLink(intent)
    }

    /** Text shared from another app that is nothing but a web address. */
    private fun sharedLink(intent: Intent): String? =
        if (intent.action != Intent.ACTION_SEND) null
        else intent.getStringExtra(Intent.EXTRA_TEXT)?.trim()?.takeIf { Regex("https?://\\S+").matches(it) }

    /** A shared link is clipped on the server and the note opens; if that fails it becomes a plain note holding the link. */
    private fun handleSharedLink(intent: Intent) {
        val url = sharedLink(intent) ?: return
        val fallback = sharedText(intent)
        android.widget.Toast.makeText(this, "Clipping…", android.widget.Toast.LENGTH_SHORT).show()
        lifecycleScope.launch {
            val session = (application as SinkApp).settings.session.first()
            val result = if (session == null) Result.failure(Exception("Signed out")) else runCatching { Api(session).clipUrl(url) }
            result.onSuccess { openNote.value = NoteTarget(it.path) }.onFailure {
                android.widget.Toast.makeText(this@MainActivity, "Couldn't clip: ${it.message}", android.widget.Toast.LENGTH_LONG).show()
                openNote.value = NoteTarget(null, text = fallback)
            }
        }
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
            if (files.isNotEmpty() || text.isNotEmpty()) openNote.value = NoteTarget(null, text = text, files = files)
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

    @OptIn(ExperimentalMaterial3ExpressiveApi::class)
    @Composable
    private fun LoggedIn(session: Session, openSettings: Boolean) {
        val settings = (application as SinkApp).settings
        val notesVm: NotesViewModel = viewModel(key = "notes:" + session.token)
        val nav = rememberNavController()
        // Settings is a page over Notes (from its menu), so back from it lands there.
        LaunchedEffect(Unit) { if (openSettings) nav.navigate("settings") { launchSingleTop = true } }
        // Wide enough (a tablet, an unfolded phone): the notes stay on the left with the open note beside them.
        val config = androidx.compose.ui.platform.LocalConfiguration.current
        val wide = config.screenWidthDp >= 840 && config.screenHeightDp >= 480
        var beside by rememberSaveable(stateSaver = NoteTargetSaver) { mutableStateOf<NoteTarget?>(null) }
        // The note beside the list saves before another takes its place.
        val flusher = remember { NoteFlusher() }
        val open = { t: NoteTarget ->
            if (wide) flusher.flush {
                beside = t
                nav.navigate("notes") {
                    popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                    launchSingleTop = true
                    restoreState = true
                }
            } else nav.navigate(t.route)
        }
        // Folded back to a phone with a note open beside the list: it carries on as its own page.
        LaunchedEffect(wide) {
            val t = beside
            if (!wide && t != null) {
                beside = null
                nav.navigate(t.route)
            }
        }
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
                open(noteTarget)
                openNote.value = null
            }
        }

        val entry by nav.currentBackStackEntryAsState()
        val route = entry?.destination?.route
        // A note (unless beside the list) and Settings are full-screen pages; the tabs keep the bar.
        val showBar = TABS.any { it.route == route }
        val openNoteAt = { path: String, line: Int? -> open(NoteTarget(path, line)) }
        // A predictive back gesture out of a note: a tick as it passes halfway, past which the note is mostly gone.
        val haptics = rememberHaptics()
        // And the tabs come back as soon as the gesture heads for a screen that has them, so they're there as the page
        // under it rises, not only once it's let go (they go again if the gesture is cancelled).
        var backToTabs by remember { mutableStateOf(false) }
        val backs = LocalNavigationEventDispatcherOwner.current?.navigationEventDispatcher
        LaunchedEffect(backs) {
            var past = false
            backs?.transitionState?.collect { s ->
                val back = (s as? NavigationEventTransitionState.InProgress)?.takeIf { it.direction == NavigationEventTransitionState.TRANSITIONING_BACK }
                val now = back != null && back.latestEvent.progress >= 0.5f && nav.currentBackStackEntry?.destination?.route?.startsWith("note?") == true
                if (now && !past) haptics.threshold()
                past = now
                backToTabs = back != null && TABS.any { it.route == nav.previousBackStackEntry?.destination?.route }
            }
        }
        // Screen changes use the theme's expressive motion (read here: the transition lambdas aren't composable).
        // Fades use the effects spec (no overshoot); movement and scale the spatial one (a little spring).
        val motion = MaterialTheme.motionScheme
        val isNote = { e: androidx.navigation.NavBackStackEntry -> e.destination.route.let { it == "settings" || it?.startsWith("note?") == true } }

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
            // Notes grow out of the card tapped (when there's one on screen) and shrink back into it.
            // After a splash, the page rises into place and the tabs slide up after it.
            val entrance = rememberEntrance()
            SharedTransitionLayout(
                Modifier.fillMaxSize().graphicsLayer {
                    val p = entrancePart(entrance(), 0, Entrance.PAGE_END_MS)
                    alpha = p
                    translationY = (1f - p) * 48.dp.toPx()
                },
            ) {
            val morph = remember(this) { CardMorph(this) }
            CompositionLocalProvider(LocalCardMorph provides morph.takeIf { !wide }) {
            NavHost(
                nav,
                startDestination = "notes",
                modifier = Modifier.fillMaxSize(),
                // A note rises over the screen it came from, which settles back a little; tabs fade through.
                enterTransition = {
                    BackMotion.predictive = false
                    if (isNote(targetState)) slideInVertically(BackMotion.open()) { it / 12 } + fadeIn(tween(260, easing = LinearOutSlowInEasing))
                    else fadeIn(motion.defaultEffectsSpec()) + scaleIn(motion.defaultSpatialSpec(), initialScale = 0.96f)
                },
                exitTransition = {
                    if (isNote(targetState)) fadeOut(tween(300)) + scaleOut(BackMotion.open(), targetScale = 0.96f)
                    else fadeOut(motion.fastEffectsSpec())
                },
                popEnterTransition = {
                    BackMotion.predictive = false
                    fadeIn(motion.defaultEffectsSpec()) + scaleIn(motion.defaultSpatialSpec(), initialScale = 0.96f)
                },
                popExitTransition = {
                    if (isNote(initialState)) slideOutVertically(motion.defaultSpatialSpec()) { it / 10 } + fadeOut(motion.fastEffectsSpec())
                    else fadeOut(motion.fastEffectsSpec())
                },
                // A back gesture out of a note or Settings: the page shrinks and drifts with the finger (away from the
                // edge it came from), its corners rounding, and only fades in the last stretch, so it reads as the
                // page being pushed away rather than vanishing; the screen under it rises back into place. All of it
                // tracks the gesture 1:1, and letting go carries it on from there. (A card the note came from takes
                // the note's bounds instead: see morphBounds.)
                predictivePopEnterTransition = {
                    BackMotion.predictive = true
                    scaleIn(BackMotion.track(), initialScale = 0.94f) + fadeIn(BackMotion.track(), initialAlpha = 0.5f)
                },
                predictivePopExitTransition = { edge ->
                    BackMotion.predictive = true
                    if (!isNote(initialState)) fadeOut(BackMotion.track())
                    else {
                        // Edge 0 is the left (NavigationEvent.EDGE_LEFT): the page drifts right, and vice versa.
                        val drift = if (edge == 0) 1 else -1
                        scaleOut(BackMotion.track(), targetScale = 0.86f) +
                            slideOutHorizontally(BackMotion.track()) { w -> drift * w / 12 } +
                            fadeOut(BackMotion.late(0.6f))
                    }
                },
            ) {
                composable("notes") {
                  CompositionLocalProvider(LocalNavScope provides this) {
                    val list = @Composable {
                        NotesScreen(
                            notesVm,
                            onOpen = { if (it != beside?.path) open(NoteTarget(it, from = morph.take())) },
                            onNew = { text -> open(NoteTarget(null, folder = notesVm.state.value.folder, text = text)) },
                            onSettings = { flusher.flush { nav.navigate("settings") } },
                        )
                    }
                    if (!wide) list()
                    else Row(Modifier.fillMaxSize()) {
                        Box(Modifier.weight(0.42f).fillMaxHeight()) { list() }
                        VerticalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                        Box(Modifier.weight(0.58f).fillMaxHeight().background(MaterialTheme.colorScheme.surfaceContainerLowest)) {
                            val t = beside
                            if (t == null) EmptyState("No note open", "Pick one from the list, or start a new one.", Icons.Outlined.EditNote)
                            else key(t) {
                                NoteScreen(
                                    notesVm,
                                    path = t.path,
                                    line = t.line,
                                    folder = t.folder,
                                    onBack = { beside = null },
                                    onOpenNote = { openNoteAt(it, null) },
                                    onSwitch = { switching.value = true },
                                    initialText = t.text,
                                    sharedFiles = t.files,
                                    flusher = flusher,
                                )
                            }
                        }
                    }
                  }
                }
                composable("todos") { TodosScreen(notesVm, onOpenNote = { p, l -> openNoteAt(p, l) }) }
                composable(
                    "note?path={path}&line={line}&folder={folder}&text={text}&files={files}&from={from}",
                    arguments = listOf(
                        navArgument("path") { type = NavType.StringType; defaultValue = "" },
                        navArgument("line") { type = NavType.IntType; defaultValue = -1 },
                        navArgument("folder") { type = NavType.StringType; defaultValue = "" },
                        navArgument("text") { type = NavType.StringType; defaultValue = "" },
                        navArgument("files") { type = NavType.StringType; defaultValue = "" },
                        navArgument("from") { type = NavType.StringType; defaultValue = "" },
                    ),
                ) { e ->
                    val path = e.arguments?.getString("path").orEmpty().ifEmpty { null }
                    CompositionLocalProvider(LocalNavScope provides this) {
                    NoteScreen(
                        notesVm,
                        path = path,
                        line = e.arguments?.getInt("line")?.takeIf { it >= 0 },
                        folder = e.arguments?.getString("folder").orEmpty(),
                        onBack = { nav.popBackStack() },
                        onOpenNote = { openNoteAt(it, null) },
                        onSwitch = { switching.value = true },
                        initialText = e.arguments?.getString("text").orEmpty(),
                        sharedFiles = e.arguments?.getString("files").orEmpty().split('\n').filter { it.isNotEmpty() }.map(::File),
                        morphKey = e.arguments?.getString("from").orEmpty().ifEmpty { null },
                        navBack = true,
                    )
                    }
                }
                composable("settings") { SettingsScreen(settings, notesVm, session.serverUrl, onBack = { nav.popBackStack() }, onCheckForUpdates = checkForUpdates) }
            }
            }
            }
            // The tabs slide away when a note opens over them and come back with the list.
            AnimatedVisibility(
                visible = showBar || backToTabs,
                enter = slideInVertically(motion.defaultSpatialSpec()) { it } + fadeIn(motion.defaultEffectsSpec()),
                exit = slideOutVertically(motion.fastSpatialSpec()) { it } + fadeOut(motion.fastEffectsSpec()),
                modifier = Modifier.align(Alignment.BottomStart).graphicsLayer {
                    val p = entrancePart(entrance(), Entrance.BAR_START_MS, Entrance.BAR_END_MS)
                    translationY = (1f - p) * size.height * 1.5f
                    alpha = p
                },
            ) {
                val badge by notesVm.todoBadge.collectAsState()
                LaunchedEffect(Unit) { notesVm.loadTodoBadge() }
                val haptics = rememberHaptics()
                FloatingNavBar(
                    TABS,
                    route,
                    mapOf("todos" to badge),
                    onSelect = { t ->
                        if (route != t.route) haptics.tick()
                        nav.navigate(t.route) {
                            // Tabs keep one copy each and remember where you were in them.
                            popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                            launchSingleTop = true
                            restoreState = true
                        }
                    },
                    modifier = Modifier.navigationBarsPadding().padding(start = 16.dp, bottom = TOOLBAR_BOTTOM),
                )
            }
          }
        }

        if (switching.value) {
            val state by notesVm.state.collectAsState()
            val opened by notesVm.opened.collectAsState()
            val scope = androidx.compose.runtime.rememberCoroutineScope()
            QuickSwitcherSheet(
                state.notes,
                opened,
                onOpen = { path ->
                    switching.value = false
                    openNoteAt(path, null)
                },
                onCreate = { title ->
                    switching.value = false
                    scope.launch {
                        val (path, error) = notesVm.newNamed(title)
                        if (path != null) openNoteAt(path, null)
                        else android.widget.Toast.makeText(this@MainActivity, error, android.widget.Toast.LENGTH_SHORT).show()
                    }
                },
                onDismiss = { switching.value = false },
            )
        }
    }

    companion object {
        const val EXTRA_OPEN_SETTINGS = "open_settings"
        const val EXTRA_OPEN_NOTE = "open_note"
        const val EXTRA_OPEN_LINE = "open_line"
        const val EXTRA_NEW_NOTE = "new_note"
        private val Loading = Session("", "")
        /** The splash's drop has landed and settled by now (see drawable/splash_icon_animated.xml). */
        private const val SPLASH_MIN_MS = 800L
        private const val SPLASH_MAX_MS = 2000L
    }
}
