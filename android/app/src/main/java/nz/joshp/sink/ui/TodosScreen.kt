package nz.joshp.sink.ui

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AddTask
import androidx.compose.material.icons.outlined.Alarm
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import nz.joshp.sink.data.TODO_NOTE
import nz.joshp.sink.data.Todo
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.temporal.ChronoUnit

/** Every `- [ ]` in every note, grouped by when it's due. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun TodosScreen(vm: NotesViewModel, onOpenNote: (String, Int) -> Unit) {
    val state by vm.todos.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var adding by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { vm.loadTodos() }

    val today = state.today
    val groups = listOf(
        "Overdue" to state.open.filter { it.due != null && it.due < today },
        "Today" to state.open.filter { it.due == today },
        "Upcoming" to state.open.filter { it.due != null && it.due > today },
        "Someday" to state.open.filter { it.due == null },
    ).filter { it.second.isNotEmpty() }

    val toggle = { t: Todo, done: Boolean ->
        scope.launch { vm.toggle(t, done)?.let { snackbar.showSnackbar(it) } }
        Unit
    }

    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceContainerLowest)) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            ScreenTitle("Todos")
            AddTodo { text, due, time -> vm.addTodo(text, due, time)?.let { snackbar.showSnackbar(it) } }
            PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = { vm.loadTodos(pull = true) }, modifier = Modifier.fillMaxSize()) {
                when {
                    !state.loaded -> Box(Modifier.fillMaxSize(), Alignment.Center) { LoadingIndicator() }
                    state.open.isEmpty() && state.error != null -> EmptyState("Can't reach your todos", state.error ?: "")
                    else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
                        if (groups.isEmpty()) item { EmptyHint() }
                        for ((name, items) in groups) {
                            item(key = "h:$name") { GroupHead(name, items.size) }
                            items(items, key = { "o:${it.path}:${it.line}" }) { t -> TodoRow(t, today, toggle, onOpenNote) }
                        }
                        item(key = "done-toggle") {
                            TextButton(onClick = vm::toggleDone, modifier = Modifier.padding(start = 8.dp, top = 8.dp)) {
                                Text(if (state.done == null) "Show done" else "Hide done")
                            }
                        }
                        state.done?.let { done ->
                            items(done.take(100), key = { "d:${it.path}:${it.line}" }) { t -> TodoRow(t, today, toggle, onOpenNote) }
                        }
                    }
                }
            }
        }
        FloatingActionButton(
            onClick = { adding = true },
            containerColor = MaterialTheme.colorScheme.primaryContainer,
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        ) { Icon(Icons.Outlined.AddTask, "New todo") }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(bottom = 80.dp))
    }

    if (adding) {
        TodoDialog(
            onAdd = { text, due ->
                adding = false
                scope.launch { snackbar.showSnackbar(vm.addTodo(text, due, null) ?: "Added to Todo.md") }
            },
            onDismiss = { adding = false },
        )
    }
}

@Composable
private fun EmptyHint() {
    Column(Modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text("All clear", style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold))
        Spacer(Modifier.size(6.dp))
        Text("Add one above, or write - [ ] thing in any note.", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun GroupHead(name: String, count: Int) {
    Row(Modifier.padding(start = 20.dp, top = 16.dp, bottom = 4.dp), verticalAlignment = Alignment.Bottom) {
        Text(name, style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold))
        Spacer(Modifier.width(8.dp))
        Text("$count", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun TodoRow(t: Todo, today: String, onToggle: (Todo, Boolean) -> Unit, onOpenNote: (String, Int) -> Unit) {
    val done = !t.open
    val overdue = t.open && t.due != null && t.due < today
    Column {
        Row(Modifier.fillMaxWidth().padding(start = 8.dp, end = 16.dp, top = 2.dp, bottom = 6.dp), verticalAlignment = Alignment.Top) {
            Checkbox(checked = done, onCheckedChange = { onToggle(t, it) })
            Column(Modifier.weight(1f).padding(top = 12.dp)) {
                Text(
                    t.text.ifEmpty { "(empty)" },
                    style = MaterialTheme.typography.bodyLarge.copy(textDecoration = if (done) TextDecoration.LineThrough else null),
                    color = if (done) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(top = 2.dp)) {
                    if (t.due != null) {
                        val color = if (overdue) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.Event, null, Modifier.size(15.dp), tint = color)
                            Spacer(Modifier.width(3.dp))
                            Text(dueLabel(t, today), style = MaterialTheme.typography.labelMedium, color = color)
                        }
                    }
                    if (t.path != TODO_NOTE) {
                        Row(Modifier.clickable { onOpenNote(t.path, t.line) }, verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.Description, null, Modifier.size(15.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.width(3.dp))
                            Text(t.noteTitle, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
        HorizontalDivider(Modifier.padding(start = 56.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
    }
}

private val HAS_TIME = Regex("""\(@\d{4}-\d{2}-\d{2}[ T]\d""")

private fun dueLabel(t: Todo, today: String): String {
    val due = LocalDate.parse(t.due)
    val days = runCatching { ChronoUnit.DAYS.between(LocalDate.parse(today), due) }.getOrDefault(99)
    val day = when (days) {
        0L -> "Today"
        1L -> "Tomorrow"
        -1L -> "Yesterday"
        in 2..6 -> due.dayOfWeek.getDisplayName(java.time.format.TextStyle.FULL, java.util.Locale.getDefault())
        else -> due.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))
    }
    val time = t.remindAt?.takeIf { HAS_TIME.containsMatchIn(t.raw) }?.let {
        java.time.Instant.ofEpochMilli(it).atZone(java.time.ZoneId.systemDefault()).toLocalTime()
            .format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT))
    }
    return if (time != null) "$day $time" else day
}

/** Text, and optionally a date and a reminder time. */
@Composable
private fun AddTodo(onAdd: suspend (String, String?, String?) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf("") }
    var due by remember { mutableStateOf<LocalDate?>(null) }
    var time by remember { mutableStateOf<LocalTime?>(null) }
    val submit = {
        val t = text.trim()
        if (t.isNotEmpty()) {
            val d = due
            val tm = time
            text = ""
            due = null
            time = null
            scope.launch { onAdd(t, d?.toString(), tm?.let { "%02d:%02d".format(it.hour, it.minute) }) }
        }
    }
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp),
    ) {
        TextField(
            value = text,
            onValueChange = { text = it },
            placeholder = { Text("Add a todo") },
            leadingIcon = { Icon(Icons.Outlined.AddTask, null) },
            trailingIcon = {
                Row {
                    IconButton(onClick = {
                        val now = due ?: LocalDate.now()
                        DatePickerDialog(context, { _, y, m, d -> due = LocalDate.of(y, m + 1, d) }, now.year, now.monthValue - 1, now.dayOfMonth).show()
                    }) { Icon(Icons.Outlined.Event, "Due date") }
                    IconButton(onClick = {
                        val now = time ?: LocalTime.of(9, 0)
                        TimePickerDialog(context, { _, h, min ->
                            time = LocalTime.of(h, min)
                            if (due == null) due = LocalDate.now()
                        }, now.hour, now.minute, android.text.format.DateFormat.is24HourFormat(context)).show()
                    }) { Icon(Icons.Outlined.Alarm, "Remind at") }
                }
            },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { submit() }),
            shape = RoundedCornerShape(16.dp),
            colors = TextFieldDefaults.colors(
                focusedIndicatorColor = Color.Transparent,
                unfocusedIndicatorColor = Color.Transparent,
                focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
        if (due != null) {
            Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                InputChip(
                    selected = true,
                    onClick = {
                        due = null
                        time = null
                    },
                    label = {
                        Text(
                            due!!.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)) +
                                (time?.let { " " + it.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)) } ?: ""),
                        )
                    },
                    leadingIcon = { Icon(Icons.Outlined.Event, null, Modifier.size(16.dp)) },
                )
                TextButton(onClick = submit) { Text("Add") }
            }
        }
    }
}
