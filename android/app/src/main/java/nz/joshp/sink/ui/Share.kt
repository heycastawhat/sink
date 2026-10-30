package nz.joshp.sink.ui

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import nz.joshp.sink.data.Api
import nz.joshp.sink.data.share
import nz.joshp.sink.data.shareLink
import nz.joshp.sink.data.unshare

/**
 * Sharing a note as a read-only link anyone can open (no sign-in, no editing). Makes the link, hands it to
 * Android's share sheet, or stops it. Mirrors the web's dialog.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun ShareDialog(api: suspend () -> Api?, path: String, title: String, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    var loading by remember { mutableStateOf(true) }
    var link by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(path) {
        runCatching { api()?.shareLink(path) }.onSuccess { link = it }.onFailure { error = it.message }
        loading = false
    }
    fun send(url: String) {
        val intent = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url).putExtra(Intent.EXTRA_SUBJECT, title)
        context.startActivity(Intent.createChooser(intent, "Share link"))
    }
    fun run(block: suspend (Api) -> Unit) {
        scope.launch {
            loading = true
            error = null
            runCatching { api()?.let { block(it) } }.onFailure { error = it.message ?: "Couldn't reach the server" }
            loading = false
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Share “$title”") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                val url = link
                Text(
                    if (url == null) "Make a link anyone can open to read this note, without signing in. They can't edit it, see your other notes, or find it in search engines."
                    else "Anyone with this link can read this note (not edit it). It shows the latest text.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                if (url != null) Text(url, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), modifier = Modifier.fillMaxWidth())
                if (loading) LoadingIndicator()
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            val url = link
            if (url == null) TextButton(enabled = !loading, onClick = { haptics.confirm(); run { a -> a.share(path).also { link = it; send(it) } } }) { Text("Create link") }
            else TextButton(onClick = { send(url) }) { Text("Send link") }
        },
        dismissButton = {
            if (link != null) TextButton(enabled = !loading, onClick = { haptics.reject(); run { a -> a.unshare(path); link = null } }) { Text("Stop sharing") }
            else TextButton(onClick = onDismiss) { Text("Close") }
        },
    )
}
