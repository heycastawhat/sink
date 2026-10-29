package nz.joshp.sink.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.StickyNote2
import androidx.compose.material.icons.outlined.CreateNewFolder
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import nz.joshp.sink.data.NoteMeta

/** Folders Sink keeps for its own use; not browsed like notes folders. */
private val HIDDEN_FOLDERS = setOf("attachments")

/** The direct subfolders of [parent] ("" for the top level), from the server's full list of folder paths. */
fun childFolders(all: List<String>, parent: String): List<String> {
    val prefix = if (parent.isEmpty()) "" else "$parent/"
    return all.asSequence()
        .filter { it.startsWith(prefix) && it.length > prefix.length }
        .map { prefix + it.removePrefix(prefix).substringBefore('/') }
        .filter { parent.isNotEmpty() || it !in HIDDEN_FOLDERS }
        .distinct()
        .sortedBy { it.lowercase() }
        .toList()
}

/** Notes inside [folder], however deep. */
fun countIn(notes: List<NoteMeta>, folder: String) = notes.count { it.path.startsWith("$folder/") }

/** A subfolder to drill into: icon, name and how many notes are inside. */
@Composable
fun FolderTile(name: String, count: Int, onClick: () -> Unit) {
    Row(
        Modifier
            .clip(RoundedCornerShape(14.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerLow)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f), RoundedCornerShape(14.dp))
            .clickable(onClick = onClick)
            .padding(start = 12.dp, end = 14.dp, top = 10.dp, bottom = 10.dp)
            .widthIn(max = 220.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.Folder, null, Modifier.size(22.dp), tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.width(10.dp))
        Column {
            Text(name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                if (count == 1) "1 note" else "$count notes",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** Notes › Projects › Sink: each part opens that folder; the last is where you are. */
@Composable
fun FolderCrumbs(folder: String, onOpen: (String) -> Unit, modifier: Modifier = Modifier) {
    val parts = folder.split('/')
    Row(
        modifier.horizontalScroll(rememberScrollState()),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Crumb("Notes", last = false) { onOpen("") }
        parts.forEachIndexed { i, name ->
            Icon(
                Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                null,
                Modifier.size(18.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            val path = parts.take(i + 1).joinToString("/")
            Crumb(name, last = i == parts.lastIndex) { onOpen(path) }
        }
    }
}

@Composable
private fun Crumb(text: String, last: Boolean, onClick: () -> Unit) {
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium.copy(fontWeight = if (last) FontWeight.SemiBold else FontWeight.Normal),
        color = if (last) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .clickable(enabled = !last, onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 4.dp),
    )
}

/** One line of text: a new folder's name, or a note's or folder's new name. */
@Composable
fun NameDialog(title: String, initial: String, confirm: String, label: String = "Name", onConfirm: (String) -> Unit, onDismiss: () -> Unit) {
    var name by remember { mutableStateOf(initial) }
    val ok = name.isNotBlank() && !name.contains('/') && !name.startsWith(".")
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            OutlinedTextField(
                name,
                { name = it },
                label = { Text(label) },
                singleLine = true,
                isError = name.isNotEmpty() && !ok,
                supportingText = if (name.isNotEmpty() && !ok) ({ Text("No slashes, and not starting with a dot") }) else null,
            )
        },
        confirmButton = { TextButton(onClick = { onConfirm(name.trim()) }, enabled = ok) { Text(confirm) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/**
 * Pick a folder: "Notes" (the top level) first, then every folder indented by depth, and "New folder…".
 * [exclude] hides a folder and everything inside it (you can't move a folder into itself).
 * [onNewFolder] creates a folder from a name typed here and returns its path, or null if it failed.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FolderPickerSheet(
    title: String,
    folders: List<String>,
    current: String?,
    exclude: String? = null,
    onPick: (String) -> Unit,
    onNewFolder: suspend (String) -> String?,
    onDismiss: () -> Unit,
) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var naming by remember { mutableStateOf(false) }
    var creating by remember { mutableStateOf<String?>(null) }
    val options = remember(folders, exclude) {
        listOf("") + folders
            .filter { it.substringBefore('/') !in HIDDEN_FOLDERS }
            .filter { exclude == null || (it != exclude && !it.startsWith("$exclude/")) }
            .sortedBy { it.lowercase() }
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Text(
            title,
            style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold),
            modifier = Modifier.padding(start = 24.dp, end = 24.dp, bottom = 8.dp),
        )
        LazyColumn(Modifier.fillMaxWidth().navigationBarsPadding()) {
            items(options, key = { "f:$it" }) { f ->
                val depth = if (f.isEmpty()) 0 else f.count { it == '/' } + 1
                val here = f == current
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable(enabled = !here) { onPick(f) }
                        .padding(start = (20 + 18 * depth).dp, end = 20.dp, top = 12.dp, bottom = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        if (f.isEmpty()) Icons.AutoMirrored.Outlined.StickyNote2 else Icons.Outlined.Folder,
                        null,
                        Modifier.size(22.dp),
                        tint = if (here) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.primary,
                    )
                    Spacer(Modifier.width(14.dp))
                    Text(
                        if (f.isEmpty()) "Notes" else f.substringAfterLast('/'),
                        style = MaterialTheme.typography.bodyLarge,
                        color = if (here) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.weight(1f),
                    )
                    if (here) Text("Here now", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            item(key = "new") {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { naming = true }
                        .padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 20.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.Start,
                ) {
                    Icon(Icons.Outlined.CreateNewFolder, null, Modifier.size(22.dp), tint = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.width(14.dp))
                    Text("New folder…", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.primary)
                }
            }
        }
    }

    if (naming) {
        NameDialog(
            title = "New folder",
            initial = "",
            confirm = "Create",
            onConfirm = { creating = it; naming = false },
            onDismiss = { naming = false },
        )
    }
    // Create, then pick it: a new folder is made to put something in.
    creating?.let { name ->
        LaunchedEffect(name) {
            val made = onNewFolder(name)
            creating = null
            if (made != null) onPick(made)
        }
    }
}
