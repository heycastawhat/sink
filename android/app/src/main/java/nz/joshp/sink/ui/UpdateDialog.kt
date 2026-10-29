package nz.joshp.sink.ui

import androidx.compose.foundation.layout.Row
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.SystemUpdate
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import nz.joshp.sink.BuildConfig
import nz.joshp.sink.data.Update

/** "Sink 0.3.0 is out": Download opens the APK in the browser, which saves it; tapping that installs over this one. */
@Composable
fun UpdateDialog(update: Update, onDownload: () -> Unit, onSkip: () -> Unit, onLater: () -> Unit) {
    AlertDialog(
        onDismissRequest = onLater,
        icon = { Icon(Icons.Outlined.SystemUpdate, null) },
        title = { Text("Sink ${update.version} is out") },
        text = {
            Text(
                "You have ${BuildConfig.VERSION_NAME}. Download the new APK, then open it to install. " +
                    "Your notes and sign-in stay as they are.",
            )
        },
        confirmButton = { TextButton(onClick = onDownload) { Text("Download") } },
        dismissButton = {
            Row {
                TextButton(onClick = onSkip) { Text("Skip this version") }
                TextButton(onClick = onLater) { Text("Later") }
            }
        },
    )
}
