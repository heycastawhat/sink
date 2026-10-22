package nz.joshp.sink.ui

import android.Manifest
import android.app.role.RoleManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings as AndroidSettings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.AccessibilityNew
import androidx.compose.material.icons.outlined.Cloud
import androidx.compose.material.icons.outlined.Palette
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material.icons.outlined.TouchApp
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import kotlinx.coroutines.launch
import nz.joshp.sink.capture.CaptureAccessibilityService
import nz.joshp.sink.capture.ScreenshotWatcher
import nz.joshp.sink.data.Settings

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(settings: Settings, vm: SinkViewModel, serverUrl: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val autoImport by settings.autoImport.collectAsState(initial = true)
    val dynamicColor by settings.dynamicColor.collectAsState(initial = false)
    var mediaGranted by remember { mutableStateOf(ScreenshotWatcher.hasPermission(context)) }
    var a11yOn by remember { mutableStateOf(CaptureAccessibilityService.isEnabled(context)) }
    var isAssistant by remember { mutableStateOf(isDefaultAssistant(context)) }
    val floatingButton by settings.floatingButton.collectAsState(initial = false)

    LifecycleResumeEffect(Unit) {
        mediaGranted = ScreenshotWatcher.hasPermission(context)
        a11yOn = CaptureAccessibilityService.isEnabled(context)
        isAssistant = isDefaultAssistant(context)
        onPauseOrDispose { }
    }

    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        mediaGranted = ScreenshotWatcher.hasPermission(context)
        if (granted && autoImport) ScreenshotWatcher.arm(context)
    }
    val mediaPermission = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE

    LaunchedEffect(autoImport, mediaGranted) {
        if (autoImport && mediaGranted) ScreenshotWatcher.arm(context) else ScreenshotWatcher.disarm(context)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") } },
            )
        },
    ) { inner ->
        Column(
            Modifier
                .padding(inner)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Section(Icons.Outlined.TouchApp, "Hold power to stash", if (isAssistant) "On" else "Off") {
                Text(
                    "Make Sink your digital assistant and holding the power button (or swiping up from a bottom corner) " +
                        "stashes the screen, along with the text on it and the page link. No floating buttons.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    "Digital assistant app > Sink, and keep \"Use text from screen\" and \"Use screenshot\" on. " +
                        "On a Pixel also check Settings > System > Gestures > Press & hold power button > Digital assistant.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Button(onClick = {
                    context.startActivity(Intent(AndroidSettings.ACTION_VOICE_INPUT_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }) { Text(if (isAssistant) "Assistant settings" else "Set as assistant") }
            }

            Section(Icons.Outlined.AccessibilityNew, "Stash tile & floating button", if (a11yOn) "On" else "Off") {
                Text(
                    "Optional. Turn on \"Sink capture\" in Accessibility to use the \"Stash screen\" Quick Settings tile " +
                        "while keeping another assistant. Screenshot only, no screen text.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                ListItem(
                    headlineContent = { Text("Floating button") },
                    supportingContent = { Text("Show the accessibility button over every app.") },
                    trailingContent = {
                        Switch(
                            checked = floatingButton,
                            enabled = a11yOn,
                            onCheckedChange = { scope.launch { settings.setFloatingButton(it) } },
                        )
                    },
                    colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
                )
                Text(
                    "Android may grey the service out for sideloaded apps. If so: App info > ⋮ > Allow restricted settings, then try again.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { context.startActivity(CaptureAccessibilityService.settingsIntent()) }) {
                        Text(if (a11yOn) "Accessibility settings" else "Turn on")
                    }
                    TextButton(onClick = {
                        context.startActivity(
                            Intent(AndroidSettings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }) { Text("App info") }
                }
            }

            Section(Icons.Outlined.PhotoLibrary, "Auto-import screenshots", null) {
                ListItem(
                    headlineContent = { Text("Stash every new screenshot") },
                    supportingContent = { Text("Like Pixel Screenshots. Only new ones, not your old ones.") },
                    trailingContent = {
                        Switch(checked = autoImport, onCheckedChange = { on ->
                            scope.launch { settings.setAutoImport(on) }
                            if (on && !mediaGranted) permission.launch(mediaPermission)
                        })
                    },
                    colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
                )
                if (autoImport && !mediaGranted) {
                    FilledTonalButton(onClick = { permission.launch(mediaPermission) }) { Text("Allow access to photos") }
                }
            }

            Section(Icons.Outlined.Palette, "Look", null) {
                ListItem(
                    headlineContent = { Text("Use wallpaper colours") },
                    supportingContent = { Text("Off keeps the Sink purple theme.") },
                    trailingContent = {
                        Switch(checked = dynamicColor, onCheckedChange = { scope.launch { settings.setDynamicColor(it) } })
                    },
                    colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
                )
            }

            Section(Icons.Outlined.Cloud, "Server", serverUrl) {
                OutlinedButton(onClick = { scope.launch { vm.logout() } }) {
                    Icon(Icons.AutoMirrored.Outlined.Logout, null)
                    Spacer(Modifier.width(8.dp))
                    Text("Log out")
                }
            }
        }
    }
}

private fun isDefaultAssistant(context: android.content.Context): Boolean =
    context.getSystemService(RoleManager::class.java).isRoleHeld(RoleManager.ROLE_ASSISTANT)

@Composable
private fun Section(icon: ImageVector, title: String, status: String?, content: @Composable () -> Unit) {
    Surface(shape = RoundedCornerShape(28.dp), color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row {
                Icon(icon, null, tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(12.dp))
                Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                status?.let { Text(it, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            content()
        }
    }
}
