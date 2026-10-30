package nz.joshp.sink.ui

import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.WindowInsets
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
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.material.icons.outlined.EditCalendar
import androidx.compose.material.icons.outlined.Update
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.DragHandle
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material.icons.outlined.KeyboardDoubleArrowDown
import androidx.compose.material.icons.outlined.KeyboardDoubleArrowUp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.rememberSwipeToDismissBoxState
import nz.joshp.sink.data.reminderTime
import java.time.DayOfWeek
import java.time.temporal.TemporalAdjusters

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
    // Not started yet (🛫 later): out of the way until their start date.
    val (later, open) = state.open.partition { it.start != null && it.start > today }
    val groups = listOf(
        "Overdue" to open.filter { it.due != null && it.due < today },
        "Today" to open.filter { it.due == today },
        "Upcoming" to open.filter { it.due != null && it.due > today },
        "Someday" to open.filter { it.due == null },
        "Starts later" to later.sortedBy { it.start },
    ).filter { it.second.isNotEmpty() }

    var editing by remember { mutableStateOf<Todo?>(null) }
    val toggle = { t: Todo, done: Boolean ->
        scope.launch {
            vm.toggle(t, done).fold(
                { ticked ->
                    if (done) {
                        // A recurring todo's next copy goes in above it; Undo takes that back out too.
                        val next = ticked.next?.let { DUE.find(it)?.groupValues?.get(1) }
                        val msg = next?.let { "Done. Next: " + LocalDate.parse(it).format(DateTimeFormatter.ofPattern("EEE d MMM")) } ?: "Done"
                        if (snackbar.showSnackbar(msg, actionLabel = "Undo", duration = SnackbarDuration.Short) == SnackbarResult.ActionPerformed) {
                            vm.undoToggle(t, ticked)?.let { snackbar.showSnackbar(it) }
                        }
                    }
                },
                { snackbar.showSnackbar(it.message ?: "Couldn't save") },
            )
        }
        Unit
    }
    // A new date keeps the reminder's time of day.
    val reschedule = { t: Todo, due: LocalDate?, msg: String? ->
        scope.launch {
            val error = vm.editTodo(t, setDate = true, due = due?.toString(), time = reminderTime(t.raw))
            (error ?: msg)?.let { snackbar.showSnackbar(it) }
        }
        Unit
    }
    val actions = TodoActions(toggle, onEdit = { editing = it }, onReschedule = { t, d -> reschedule(t, d, null) }, onOpenNote)

    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceContainerLowest)) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            ScreenTitle("Todos")
            PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = { vm.loadTodos(pull = true) }, modifier = Modifier.fillMaxSize()) {
                when {
                    !state.loaded -> Box(Modifier.fillMaxSize(), Alignment.Center) { LoadingIndicator() }
                    state.open.isEmpty() && state.error != null -> EmptyState("Can't reach your todos", state.error ?: "")
                    // From the bottom up, like Notes: overdue and today's right above the add field, later ones and
                    // the done list further up. Within a group the soonest is lowest; each heading sits above its group.
                    else -> LazyColumn(Modifier.fillMaxSize(), reverseLayout = true, contentPadding = PaddingValues(top = 8.dp, bottom = toolbarClearance(extra = 76.dp))) {
                        if (groups.isEmpty()) item { EmptyHint() }
                        for ((name, items) in groups) {
                            items(items, key = { "o:${it.path}:${it.line}" }) { t ->
                                // Swipe left: tomorrow.
                                SwipeToTomorrow(onSwiped = { reschedule(t, quickDates(today)[1].second, "Moved to tomorrow") }) {
                                    TodoRow(t, today, actions)
                                }
                            }
                            item(key = "h:$name") {
                                GroupHead(name, items.size) {
                                    if (name == "Overdue") {
                                        TextButton(onClick = { scope.launch { snackbar.showSnackbar(vm.moveOverdueToToday()) } }) { Text("Move all to today") }
                                    }
                                }
                            }
                        }
                        item(key = "done-toggle") {
                            TextButton(onClick = vm::toggleDone, modifier = Modifier.padding(start = 8.dp, top = 8.dp)) {
                                Text(if (state.done == null) "Show done" else "Hide done")
                            }
                        }
                        state.done?.let { done ->
                            items(done.take(100), key = { "d:${it.path}:${it.line}" }) { t -> TodoRow(t, today, actions) }
                        }
                    }
                }
            }
        }
        // Quick add sits at the bottom, above the floating tabs (on the keyboard while typing), like Notes' search.
        val keyboardUp = WindowInsets.ime.getBottom(LocalDensity.current) > 0
        Box(
            Modifier
                .align(Alignment.BottomStart)
                .fillMaxWidth()
                .then(if (keyboardUp) Modifier.imePadding() else Modifier.navigationBarsPadding().padding(bottom = TOOLBAR_BOTTOM + TOOLBAR_HEIGHT + 4.dp))
                .background(MaterialTheme.colorScheme.surfaceContainerLowest),
        ) {
            AddTodo { text, due, time -> vm.addTodo(text, due, time)?.let { snackbar.showSnackbar(it) } }
        }
        if (!keyboardUp) {
            FloatingActionButton(
                onClick = { adding = true },
                containerColor = MaterialTheme.colorScheme.primaryContainer,
                modifier = Modifier.align(Alignment.BottomEnd).navigationBarsPadding().padding(end = 16.dp, bottom = TOOLBAR_BOTTOM + 4.dp),
            ) { Icon(Icons.Outlined.AddTask, "New todo") }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(bottom = toolbarClearance(extra = 76.dp)))
    }

    editing?.let { t ->
        EditTodoDialog(
            t,
            today,
            onSave = { text, due, time ->
                editing = null
                val dateChanged = due?.toString() != t.due || time != reminderTime(t.raw)
                if (text != t.text || dateChanged) {
                    scope.launch {
                        vm.editTodo(t, text.takeIf { it != t.text }, dateChanged, due?.toString(), time)?.let { snackbar.showSnackbar(it) }
                    }
                }
            },
            onCancelTodo = {
                editing = null
                scope.launch { snackbar.showSnackbar(vm.cancelTodo(t)) }
            },
            onDismiss = { editing = null },
        )
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
private fun GroupHead(name: String, count: Int, action: @Composable () -> Unit = {}) {
    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 16.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(name, style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold))
        Spacer(Modifier.width(8.dp))
        Text("$count", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.weight(1f))
        action()
    }
}

/** What a todo row can do: tick, edit (tap the text), reschedule (the date or the calendar button), open its note. */
private class TodoActions(
    val toggle: (Todo, Boolean) -> Unit,
    val onEdit: (Todo) -> Unit,
    val onReschedule: (Todo, LocalDate?) -> Unit,
    val onOpenNote: (String, Int) -> Unit,
)

/** Tasks priorities other than none (3): label and icon. */
private val PRIORITY = mapOf(
    0 to ("Highest" to Icons.Outlined.KeyboardDoubleArrowUp),
    1 to ("High" to Icons.Outlined.KeyboardArrowUp),
    2 to ("Medium" to Icons.Outlined.DragHandle),
    4 to ("Low" to Icons.Outlined.KeyboardArrowDown),
    5 to ("Lowest" to Icons.Outlined.KeyboardDoubleArrowDown),
)

private val DUE = Regex("""📅\uFE0F?\s*(\d{4}-\d{2}-\d{2})""")

/** One-tap dates, counted from the server's today (the user's time zone). Next week is next Monday. */
private fun quickDates(today: String): List<Pair<String, LocalDate?>> {
    val d = runCatching { LocalDate.parse(today) }.getOrElse { LocalDate.now() }
    return listOf("Today" to d, "Tomorrow" to d.plusDays(1), "Next week" to d.with(TemporalAdjusters.next(DayOfWeek.MONDAY)), "No date" to null)
}

@Composable
private fun SwipeToTomorrow(onSwiped: () -> Unit, content: @Composable () -> Unit) {
    val state = rememberSwipeToDismissBoxState()
    val scope = rememberCoroutineScope()
    SwipeToDismissBox(
        state = state,
        enableDismissFromStartToEnd = false,
        onDismiss = {
            onSwiped()
            // The row stays (with its new date) once the list reloads; slide it back meanwhile.
            scope.launch { state.reset() }
        },
        backgroundContent = {
            Row(
                Modifier.fillMaxSize().background(MaterialTheme.colorScheme.secondaryContainer).padding(horizontal = 24.dp),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Tomorrow", color = MaterialTheme.colorScheme.onSecondaryContainer, style = MaterialTheme.typography.labelLarge)
                Spacer(Modifier.width(8.dp))
                Icon(Icons.Outlined.Update, null, tint = MaterialTheme.colorScheme.onSecondaryContainer)
            }
        },
    ) {
        Box(Modifier.background(MaterialTheme.colorScheme.surfaceContainerLowest)) { content() }
    }
}

/** The calendar button's menu: the quick dates, or the full editor for any other day. */
@Composable
private fun RescheduleMenu(t: Todo, today: String, actions: TodoActions, expanded: Boolean, onDismiss: () -> Unit) {
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        for ((label, date) in quickDates(today)) {
            if (date?.toString() == t.due || (date == null && t.due == null)) continue
            DropdownMenuItem(
                text = { Text(label) },
                trailingIcon = date?.let { { Text(it.format(DateTimeFormatter.ofPattern("EEE d MMM")), color = MaterialTheme.colorScheme.onSurfaceVariant) } },
                onClick = {
                    onDismiss()
                    actions.onReschedule(t, date)
                },
            )
        }
        DropdownMenuItem(
            text = { Text("Pick a date…") },
            leadingIcon = { Icon(Icons.Outlined.EditCalendar, null) },
            onClick = {
                onDismiss()
                actions.onEdit(t)
            },
        )
    }
}

@Composable
private fun TodoRow(t: Todo, today: String, actions: TodoActions) {
    val done = !t.open
    val overdue = t.open && t.due != null && t.due < today
    var menu by remember { mutableStateOf(false) }
    Column {
        Row(Modifier.fillMaxWidth().padding(start = 8.dp, end = 4.dp, top = 2.dp, bottom = 6.dp), verticalAlignment = Alignment.Top) {
            Checkbox(checked = done, onCheckedChange = { actions.toggle(t, it) })
            Column(Modifier.weight(1f).padding(top = 12.dp).then(if (done) Modifier else Modifier.clickable { actions.onEdit(t) })) {
                Text(
                    t.text.ifEmpty { "(empty)" },
                    style = MaterialTheme.typography.bodyLarge.copy(textDecoration = if (done) TextDecoration.LineThrough else null),
                    color = if (done) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(top = 2.dp)) {
                    PRIORITY[t.priority]?.let { (label, icon) ->
                        val color = if (t.priority <= 1) MaterialTheme.colorScheme.error else if (t.priority == 2) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(icon, null, Modifier.size(15.dp), tint = color)
                            Spacer(Modifier.width(3.dp))
                            Text(label, style = MaterialTheme.typography.labelMedium, color = color)
                        }
                    }
                    if (t.start != null && t.start > today) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.Flag, null, Modifier.size(15.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.width(3.dp))
                            Text("Starts " + dayLabel(LocalDate.parse(t.start), today), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    if (t.due != null) {
                        val color = if (overdue) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant
                        Row(Modifier.then(if (done) Modifier else Modifier.clickable { menu = true }), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.Event, null, Modifier.size(15.dp), tint = color)
                            Spacer(Modifier.width(3.dp))
                            Text(dueLabel(t, today), style = MaterialTheme.typography.labelMedium, color = color)
                        }
                    }
                    if (t.path != TODO_NOTE) {
                        Row(Modifier.clickable { actions.onOpenNote(t.path, t.line) }, verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.Description, null, Modifier.size(15.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.width(3.dp))
                            Text(t.noteTitle, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
            if (!done) {
                Box {
                    IconButton(onClick = { menu = true }) {
                        Icon(Icons.Outlined.EditCalendar, "Reschedule", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    RescheduleMenu(t, today, actions, menu) { menu = false }
                }
            }
        }
        HorizontalDivider(Modifier.padding(start = 56.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
    }
}

/** Text, date and reminder time for one todo, with the quick dates as chips. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun EditTodoDialog(
    t: Todo,
    today: String,
    onSave: (String, LocalDate?, String?) -> Unit,
    onCancelTodo: () -> Unit,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    var text by remember { mutableStateOf(t.text) }
    var due by remember { mutableStateOf(t.due?.let { runCatching { LocalDate.parse(it) }.getOrNull() }) }
    var time by remember { mutableStateOf(reminderTime(t.raw)?.let { LocalTime.parse(it) }) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Edit todo") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(text, { text = it }, label = { Text("Todo") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for ((label, date) in quickDates(today)) {
                        FilterChip(
                            selected = due == date,
                            onClick = {
                                due = date
                                if (date == null) time = null
                            },
                            label = { Text(label) },
                        )
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = {
                        val now = due ?: LocalDate.now()
                        DatePickerDialog(context, { _, y, m, d -> due = LocalDate.of(y, m + 1, d) }, now.year, now.monthValue - 1, now.dayOfMonth).show()
                    }) {
                        Icon(Icons.Outlined.Event, null)
                        Text("  " + (due?.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)) ?: "No date"))
                    }
                    TextButton(onClick = {
                        val now = time ?: LocalTime.of(9, 0)
                        TimePickerDialog(context, { _, h, min ->
                            time = LocalTime.of(h, min)
                            if (due == null) due = quickDates(today)[0].second
                        }, now.hour, now.minute, android.text.format.DateFormat.is24HourFormat(context)).show()
                    }) {
                        Icon(Icons.Outlined.Alarm, null)
                        Text("  " + (time?.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)) ?: "No reminder"))
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onSave(text.trim(), due, time?.let { "%02d:%02d".format(it.hour, it.minute) }) },
                enabled = text.isNotBlank(),
            ) { Text("Save") }
        },
        dismissButton = {
            Row {
                TextButton(onClick = onCancelTodo) { Text("Cancel todo", color = MaterialTheme.colorScheme.error) }
                TextButton(onClick = onDismiss) { Text("Close") }
            }
        },
    )
}

private val HAS_TIME = Regex("""\(@\d{4}-\d{2}-\d{2}[ T]\d""")

private fun dayLabel(date: LocalDate, today: String): String =
    when (runCatching { ChronoUnit.DAYS.between(LocalDate.parse(today), date) }.getOrDefault(99)) {
        0L -> "today"
        1L -> "tomorrow"
        -1L -> "yesterday"
        in 2..6 -> date.dayOfWeek.getDisplayName(java.time.format.TextStyle.FULL, java.util.Locale.getDefault())
        else -> date.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))
    }

private fun dueLabel(t: Todo, today: String): String {
    val day = dayLabel(LocalDate.parse(t.due), today).replaceFirstChar { it.uppercase() }
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
