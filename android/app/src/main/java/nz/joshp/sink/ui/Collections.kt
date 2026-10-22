package nz.joshp.sink.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
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
internal fun NameDialog(title: String, initial: String, onDismiss: () -> Unit, onSave: suspend (String) -> Result<Unit>) {
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
