package nz.joshp.sink.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.History
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import nz.joshp.sink.data.Api
import nz.joshp.sink.data.Version
import nz.joshp.sink.data.versionText
import nz.joshp.sink.data.versions
import java.text.DateFormat
import java.util.Date

/**
 * Version history for one note: its earlier versions, newest first (Sink keeps the text from before each editing
 * sitting). Tapping one shows its text; [onRestore] gets that text to put back. Mirrors the web's dialog.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun VersionHistorySheet(api: suspend () -> Api?, path: String, onRestore: (String) -> Unit, onDismiss: () -> Unit) {
    val haptics = rememberHaptics()
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    var versions by remember { mutableStateOf<List<Version>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reading by remember { mutableStateOf<Pair<Version, String>?>(null) }
    LaunchedEffect(path) {
        runCatching { api()?.versions(path) }
            .onSuccess { versions = it.orEmpty() }
            .onFailure { error = it.message ?: "Couldn't load the history" }
    }
    val time = { at: Long -> DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(at)) }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 12.dp)) {
            Text(
                "Version history",
                style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold),
                modifier = Modifier.padding(horizontal = 24.dp),
            )
            Text(
                "Sink keeps the text from before each editing session, newest first.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 24.dp, end = 24.dp, top = 4.dp, bottom = 8.dp),
            )
            val open = reading
            when {
                error != null -> Text(error!!, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(24.dp))
                versions == null -> Box(Modifier.fillMaxWidth().padding(32.dp), Alignment.Center) { LoadingIndicator() }
                open != null -> {
                    Text(
                        time(open.first.at),
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.padding(horizontal = 24.dp, vertical = 4.dp),
                    )
                    Text(
                        open.second,
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(max = 380.dp)
                            .padding(horizontal = 16.dp)
                            .background(MaterialTheme.colorScheme.surfaceContainerLowest, RoundedCornerShape(12.dp))
                            .verticalScroll(rememberScrollState())
                            .padding(12.dp),
                    )
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        TextButton(onClick = { reading = null }) {
                            Icon(Icons.AutoMirrored.Outlined.ArrowBack, null, Modifier.size(18.dp))
                            Spacer(Modifier.width(6.dp))
                            Text("All versions")
                        }
                        Spacer(Modifier.weight(1f))
                        Button(onClick = { haptics.confirm(); onRestore(open.second) }) { Text("Restore") }
                    }
                }
                versions!!.isEmpty() -> Text(
                    "No earlier versions yet. They start once you edit this note.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(24.dp),
                )
                else -> LazyColumn(Modifier.fillMaxWidth().heightIn(max = 460.dp)) {
                    items(versions!!, key = { it.id }) { v ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable {
                                    scope.launch {
                                        runCatching { api()?.versionText(path, v.id) }
                                            .onSuccess { text -> if (text != null) reading = v to text }
                                            .onFailure { error = it.message ?: "Couldn't load that version" }
                                    }
                                }
                                .padding(horizontal = 24.dp, vertical = 12.dp),
                            horizontalArrangement = Arrangement.spacedBy(14.dp),
                        ) {
                            Icon(Icons.Outlined.History, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            Column(Modifier.weight(1f)) {
                                Text(time(v.at), style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium))
                                Text(
                                    v.preview.ifBlank { "Empty" },
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
