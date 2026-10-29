package nz.joshp.sink.ui

import android.app.DatePickerDialog
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AddTask
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.CreateNewFolder
import androidx.compose.material.icons.outlined.Draw
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FloatingActionButtonMenu
import androidx.compose.material3.FloatingActionButtonMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.ToggleFloatingActionButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import java.time.LocalDate

/**
 * The "new" button on Notes and Recents: a toggle FAB that opens a stack of labelled actions (Material 3 Expressive's
 * FAB menu) for a note, a todo, a folder or a board. [folder] is where new things go.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun NewMenuFab(
    vm: NotesViewModel,
    folder: String,
    snackbar: SnackbarHostState,
    onNewNote: () -> Unit,
    onOpen: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    var expanded by remember { mutableStateOf(false) }
    var todo by remember { mutableStateOf(false) }
    var naming by remember { mutableStateOf(false) }
    BackHandler(enabled = expanded) { expanded = false }
    fun pick(action: () -> Unit) {
        expanded = false
        action()
    }

    FloatingActionButtonMenu(
        expanded = expanded,
        button = {
            ToggleFloatingActionButton(checked = expanded, onCheckedChange = { expanded = it }) {
                Icon(if (expanded) Icons.Outlined.Close else Icons.Outlined.Add, if (expanded) "Close" else "New")
            }
        },
        modifier = modifier,
    ) {
        FloatingActionButtonMenuItem(
            onClick = { pick(onNewNote) },
            icon = { Icon(Icons.Outlined.Edit, null) },
            text = { Text("Note") },
        )
        FloatingActionButtonMenuItem(
            onClick = { pick { todo = true } },
            icon = { Icon(Icons.Outlined.AddTask, null) },
            text = { Text("Todo") },
        )
        FloatingActionButtonMenuItem(
            onClick = { pick { naming = true } },
            icon = { Icon(Icons.Outlined.CreateNewFolder, null) },
            text = { Text("Folder") },
        )
        FloatingActionButtonMenuItem(
            onClick = {
                pick {
                    scope.launch {
                        val (path, error) = vm.newBoard()
                        if (path != null) onOpen(path) else snackbar.showSnackbar(error ?: "Couldn't make a board")
                    }
                }
            },
            icon = { Icon(Icons.Outlined.Draw, null) },
            text = { Text("Board") },
        )
    }

    if (todo) {
        TodoDialog(
            onAdd = { text, due ->
                todo = false
                scope.launch { snackbar.showSnackbar(vm.addTodo(text, due, null) ?: "Added to Todo.md") }
            },
            onDismiss = { todo = false },
        )
    }
    if (naming) {
        NameDialog(
            title = if (folder.isEmpty()) "New folder" else "New folder in ${folder.substringAfterLast('/')}",
            initial = "",
            confirm = "Create",
            onConfirm = { name ->
                naming = false
                scope.launch { vm.newFolder(folder, name)?.let { snackbar.showSnackbar(it) } }
            },
            onDismiss = { naming = false },
        )
    }
}

/** A quick todo: its text and an optional due date. It goes to Todo.md. */
@Composable
fun TodoDialog(onAdd: (text: String, due: String?) -> Unit, onDismiss: () -> Unit) {
    val context = LocalContext.current
    var text by remember { mutableStateOf("") }
    var due by remember { mutableStateOf<LocalDate?>(null) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New todo") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(text, { text = it }, label = { Text("Todo") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                TextButton(onClick = {
                    val now = due ?: LocalDate.now()
                    DatePickerDialog(context, { _, y, m, d -> due = LocalDate.of(y, m + 1, d) }, now.year, now.monthValue - 1, now.dayOfMonth).show()
                }) {
                    Icon(Icons.Outlined.Event, null)
                    Text(due?.let { "  Due $it" } ?: "  Add a due date")
                }
            }
        },
        confirmButton = { TextButton(onClick = { onAdd(text.trim(), due?.toString()) }, enabled = text.isNotBlank()) { Text("Add") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
