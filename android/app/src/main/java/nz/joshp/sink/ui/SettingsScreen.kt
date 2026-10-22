package nz.joshp.sink.ui

import android.Manifest
import android.app.role.RoleManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings as AndroidSettings
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.AccessibilityNew
import androidx.compose.material.icons.outlined.BrightnessAuto
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.DarkMode
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.LightMode
import androidx.compose.material.icons.outlined.Palette
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.TouchApp
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import kotlinx.coroutines.launch
import nz.joshp.sink.capture.CaptureAccessibilityService
import nz.joshp.sink.capture.ScreenshotWatcher
import nz.joshp.sink.data.Settings

@Composable
fun SettingsScreen(settings: Settings, vm: SinkViewModel, serverUrl: String, onBack: (() -> Unit)? = null) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val autoImport by settings.autoImport.collectAsState(initial = true)
    val dynamicColor by settings.dynamicColor.collectAsState(initial = false)
    val themeMode by settings.themeMode.collectAsState(initial = "auto")
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

    Column(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.surfaceContainerLowest)
            .statusBarsPadding()
            .verticalScroll(rememberScrollState())
            .padding(bottom = 24.dp),
    ) {
        ScreenTitle("Settings", onBack = onBack)
        Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Card("Appearance") {
                Text("Theme", style = MaterialTheme.typography.titleSmall)
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    val modes = listOf(
                        Triple("auto", "System", Icons.Outlined.BrightnessAuto),
                        Triple("light", "Light", Icons.Outlined.LightMode),
                        Triple("dark", "Dark", Icons.Outlined.DarkMode),
                    )
                    modes.forEachIndexed { i, (mode, label, icon) ->
                        SegmentedButton(
                            selected = themeMode == mode,
                            onClick = { scope.launch { settings.setThemeMode(mode) } },
                            shape = SegmentedButtonDefaults.itemShape(i, modes.size),
                            icon = { Icon(icon, null, Modifier.size(SegmentedButtonDefaults.IconSize)) },
                        ) { Text(label) }
                    }
                }
                ToggleRow(Icons.Outlined.Palette, "Use wallpaper colours", "Off keeps the Sink purple theme.", dynamicColor) {
                    scope.launch { settings.setDynamicColor(it) }
                }
            }

            Card("Capturing", status = null) {
                Detail(Icons.Outlined.TouchApp, "Hold power to stash", if (isAssistant) "On" else "Off") {
                    Text(
                        "Make Sink your digital assistant and holding the power button (or swiping up from a bottom corner) " +
                            "stashes the screen, along with the text on it and the page link.",
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

                ToggleRow(Icons.Outlined.PhotoLibrary, "Auto-import screenshots", "Stashes every new screenshot, like Pixel Screenshots.", autoImport) { on ->
                    scope.launch { settings.setAutoImport(on) }
                    if (on && !mediaGranted) permission.launch(mediaPermission)
                }
                if (autoImport && !mediaGranted) {
                    FilledTonalButton(onClick = { permission.launch(mediaPermission) }) { Text("Allow access to photos") }
                }

                Detail(Icons.Outlined.AccessibilityNew, "Stash tile & floating button", if (a11yOn) "On" else "Off") {
                    Text(
                        "Optional. Turn on \"Sink capture\" in Accessibility for the \"Stash screen\" Quick Settings tile " +
                            "while keeping another assistant. Screenshot only, no screen text.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    ToggleRow(null, "Floating button", "Show the accessibility button over every app.", floatingButton, enabled = a11yOn) {
                        scope.launch { settings.setFloatingButton(it) }
                    }
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
            }

            Card("AI assistants") {
                Text(
                    "Let Claude, ChatGPT, Poke or another assistant search your sink. Add a custom connector (MCP server) " +
                        "with this URL; you'll sign in and approve it.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                val url = "$serverUrl/mcp"
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(14.dp))
                        .background(MaterialTheme.colorScheme.surfaceContainerHighest)
                        .padding(start = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(Icons.Outlined.Hub, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.width(10.dp))
                    Text(url, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace), modifier = Modifier.weight(1f))
                    IconButton(onClick = {
                        context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Sink MCP", url))
                        Toast.makeText(context, "Copied", Toast.LENGTH_SHORT).show()
                    }) { Icon(Icons.Outlined.ContentCopy, "Copy connector URL") }
                }
                Text(
                    "Revoke assistants and other devices from Settings in Sink on the web.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Card("Account") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Dns, null, tint = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text("Server", style = MaterialTheme.typography.titleSmall)
                        Text(serverUrl, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                OutlinedButton(onClick = { scope.launch { vm.logout() } }) {
                    Icon(Icons.AutoMirrored.Outlined.Logout, null)
                    Spacer(Modifier.width(8.dp))
                    Text("Sign out")
                }
            }
        }
    }
}

private fun isDefaultAssistant(context: android.content.Context): Boolean =
    context.getSystemService(RoleManager::class.java).isRoleHeld(RoleManager.ROLE_ASSISTANT)

@Composable
private fun Card(title: String, status: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Surface(shape = RoundedCornerShape(24.dp), color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold), modifier = Modifier.weight(1f))
                status?.let { Text(it, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            content()
        }
    }
}

/** A titled block inside a card, with an icon and an On/Off status. */
@Composable
private fun Detail(icon: ImageVector, title: String, status: String?, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconBadge(icon)
            Spacer(Modifier.width(12.dp))
            Text(title, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
            status?.let { Text(it, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        content()
    }
}

@Composable
private fun ToggleRow(icon: ImageVector?, title: String, sub: String, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (icon != null) {
            IconBadge(icon)
            Spacer(Modifier.width(12.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = checked, onCheckedChange = onChange, enabled = enabled)
    }
}

@Composable
private fun IconBadge(icon: ImageVector) {
    Box(
        Modifier
            .size(36.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.secondaryContainer),
        Alignment.Center,
    ) { Icon(icon, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSecondaryContainer) }
}
