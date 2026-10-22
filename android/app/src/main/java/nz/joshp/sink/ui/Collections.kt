package nz.joshp.sink.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.CreateNewFolder
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import nz.joshp.sink.data.SinkCollection

/** Filter row on home: one chip per collection, plus rename/delete for the open one and a "New" chip. */
@Composable
fun CollectionsRow(vm: SinkViewModel, collections: List<SinkCollection>, selected: String?) {
    var naming by remember { mutableStateOf<SinkCollection?>(null) }
    var creating by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<SinkCollection?>(null) }
    val scope = rememberCoroutineScope()
    val current = collections.firstOrNull { it.id == selected }

    LazyRow(
        contentPadding = PaddingValues(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.padding(top = 4.dp),
    ) {
        items(collections, key = { it.id }) { col ->
            FilterChip(
                selected = col.id == selected,
                onClick = { vm.setCollection(col.id) },
                label = { Text("${col.name}  ${col.count}") },
                leadingIcon = { Icon(Icons.Outlined.Folder, null, Modifier.size(FilterChipDefaults.IconSize)) },
            )
        }
        if (current != null) {
            item(key = "rename") { IconButton(onClick = { naming = current }) { Icon(Icons.Outlined.Edit, "Rename collection") } }
            item(key = "delete") { IconButton(onClick = { deleting = current }) { Icon(Icons.Outlined.Delete, "Delete collection") } }
        }
        item(key = "new") {
            AssistChip(
                onClick = { creating = true },
                label = { Text("New collection") },
                leadingIcon = { Icon(Icons.Outlined.CreateNewFolder, null, Modifier.size(AssistChipDefaults.IconSize)) },
            )
        }
    }

    if (creating) {
        NameDialog("New collection", "", onDismiss = { creating = false }) { name ->
            vm.createCollection(name).map { }
        }
    }
    naming?.let { col ->
        NameDialog("Rename collection", col.name, onDismiss = { naming = null }) { name ->
            vm.renameCollection(col.id, name).map { }
        }
    }
    deleting?.let { col ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete “${col.name}”?") },
            text = { Text("The captures in it stay in the sink.") },
            confirmButton = {
                TextButton(onClick = {
                    deleting = null
                    scope.launch { vm.deleteCollection(col.id) }
                }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
        )
    }
}

/** Detail screen: toggle which collections this capture is filed in. Changes save straight away. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CollectionPicker(
    vm: SinkViewModel,
    collections: List<SinkCollection>,
    memberOf: List<String>,
    onChange: (List<String>) -> Unit,
) {
    var creating by remember { mutableStateOf(false) }
    Text("Collections", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        for (col in collections) {
            val inIt = col.id in memberOf
            FilterChip(
                selected = inIt,
                onClick = { onChange(if (inIt) memberOf - col.id else memberOf + col.id) },
                label = { Text(col.name) },
            )
        }
        AssistChip(
            onClick = { creating = true },
            label = { Text("New") },
            leadingIcon = { Icon(Icons.Outlined.Add, null, Modifier.size(AssistChipDefaults.IconSize)) },
        )
    }
    if (creating) {
        NameDialog("New collection", "", onDismiss = { creating = false }) { name ->
            vm.createCollection(name).map { onChange(memberOf + it.id) }
        }
    }
}

/** Asks for a name; stays open showing the error if [onSave] fails (e.g. name taken). */
@Composable
private fun NameDialog(title: String, initial: String, onDismiss: () -> Unit, onSave: suspend (String) -> Result<Unit>) {
    var name by remember { mutableStateOf(initial) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    fun save() {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return
        scope.launch {
            onSave(trimmed).onSuccess { onDismiss() }.onFailure { error = it.message ?: "Couldn't save" }
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it.take(60); error = null },
                label = { Text("Name") },
                singleLine = true,
                isError = error != null,
                supportingText = error?.let { { Text(it) } },
            )
        },
        confirmButton = { TextButton(onClick = ::save, enabled = name.isNotBlank()) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
