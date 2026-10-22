package nz.joshp.sink.ui

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import nz.joshp.sink.data.SignIn
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import nz.joshp.sink.SinkApp
import nz.joshp.sink.data.Session
import nz.joshp.sink.ui.theme.SinkTheme

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
            // Sentinel distinguishes "still loading" from "logged out" so login doesn't flash.
            val session by settings.session.collectAsState(initial = Loading)
            val lastServer by settings.lastServerUrl.collectAsState(initial = null)

            SinkTheme(dynamicColor = dynamic) {
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

    // Set by reminder notifications; LoggedIn navigates to it.
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

    @androidx.compose.runtime.Composable
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

        NavHost(nav, startDestination = start) {
            composable("home") {
                HomeScreen(vm, session.serverUrl, onOpen = { nav.navigate("capture/$it") }, onSettings = { nav.navigate("settings") })
            }
            composable("capture/{id}") { entry ->
                DetailScreen(vm, entry.arguments?.getString("id")!!, onBack = { nav.popBackStack() })
            }
            composable("settings") {
                SettingsScreen(settings, vm, session.serverUrl, onBack = {
                    if (!nav.popBackStack()) nav.navigate("home") { popUpTo("settings") { inclusive = true } }
                })
            }
        }
    }

    companion object {
        const val EXTRA_OPEN_SETTINGS = "open_settings"
        const val EXTRA_OPEN_CAPTURE = "open_capture"
        private val Loading = Session("", "")
    }
}
