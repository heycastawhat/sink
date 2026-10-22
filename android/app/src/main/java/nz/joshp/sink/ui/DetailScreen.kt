package nz.joshp.sink.ui

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Label
import androidx.compose.material.icons.automirrored.outlined.TrendingDown
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.outlined.AlarmOn
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.DeleteForever
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Place
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.RestoreFromTrash
import androidx.compose.material.icons.outlined.Sell
import androidx.compose.material.icons.outlined.Unarchive
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FilledIconToggleButton
import androidx.compose.material3.FloatingToolbarDefaults
import androidx.compose.material3.HorizontalFloatingToolbar
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.InputChipDefaults
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import nz.joshp.sink.data.Capture
import nz.joshp.sink.data.Reminder
import nz.joshp.sink.reminders.Reminders

private val ENTITY_LABELS = mapOf(
    "dates" to ("When" to Icons.Outlined.Event),
    "urls" to ("Links" to Icons.Outlined.Link),
    "prices" to ("Price" to Icons.Outlined.Sell),
    "addresses" to ("Where" to Icons.Outlined.Place),
    "people" to ("People" to Icons.Outlined.Person),
)

@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class, ExperimentalLayoutApi::class)
@Composable
fun DetailScreen(vm: SinkViewModel, id: String, onBack: () -> Unit) {
    val listState by vm.state.collectAsStateWithLifecycle()
    var capture by remember { mutableStateOf(listState.items.firstOrNull { it.id == id }) }
    var full by remember { mutableStateOf<Capture?>(null) }
    var title by remember { mutableStateOf(capture?.title ?: "") }
    var note by remember { mutableStateOf(capture?.note ?: "") }
    var newTag by remember { mutableStateOf("") }
    var showText by remember { mutableStateOf(false) }
    var confirmPurge by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val context = LocalContext.current

    LaunchedEffect(id) {
        val fresh = vm.get(id) ?: return@LaunchedEffect
        full = fresh
        capture = fresh
        title = fresh.title ?: ""
        note = fresh.note ?: ""
    }
    // Keep polling while the AI is still reading, so the page fills in live.
    LaunchedEffect(capture?.busy) {
        while (capture?.busy == true) {
            delay(2500)
            vm.get(id)?.let { fresh ->
                full = fresh
                capture = fresh
                if (title.isBlank()) title = fresh.title ?: ""
                vm.replace(fresh)
            }
        }
    }

    fun saveAndBack() {
        val c = full ?: capture
        if (c != null) {
            // Tags save as they change; title and note save on the way out.
            val body = buildJsonObject {
                if (title.trim() != (c.title ?: "")) put("title", title.trim())
                if (note.trim() != (c.note ?: "")) put("note_text", note.trim())
            }
            if (body.isNotEmpty()) scope.launch { vm.patch(c.id, body) }
        }
        onBack()
    }

    BackHandler { saveAndBack() }

    val c = capture
    Scaffold(
        topBar = {
            TopAppBar(
                title = {},
                navigationIcon = { IconButton(onClick = ::saveAndBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLowest),
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
        containerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
    ) { inner ->
        if (c == null) {
            Box(Modifier.fillMaxSize(), Alignment.Center) { LoadingIndicator() }
            return@Scaffold
        }
        Box(Modifier.padding(inner).fillMaxSize()) {
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .imePadding()
                    .padding(horizontal = 16.dp)
                    .padding(bottom = 120.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                val kind = kindOf(c.kind)
                val shot = RoundedCornerShape(22.dp)
                AsyncImage(
                    model = CaptureImages.absolute(c.imageUrl),
                    contentDescription = "Screenshot",
                    contentScale = ContentScale.FillWidth,
                    alignment = Alignment.TopCenter,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 440.dp)
                        .clip(shot)
                        .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                        .border(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f), shot),
                )

                Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    kind?.let {
                        KindPill(it.icon, it.one, it.hue)
                        Spacer(Modifier.width(10.dp))
                    }
                    Text(
                        "${relativeDay(c.createdAt)}, ${timeOf(c.createdAt)}",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                if (c.busy) {
                    StatusBanner(null, "AI is reading this…", error = false)
                } else if (c.status == "failed") {
                    StatusBanner(Icons.Outlined.ErrorOutline, "AI couldn't process this. ${c.error ?: ""}", error = true)
                }

                // The title is the heading itself; tap to edit.
                BasicTextField(
                    value = title,
                    onValueChange = { title = it.replace("\n", " ") },
                    textStyle = MaterialTheme.typography.headlineSmall.copy(
                        fontWeight = FontWeight.Bold,
                        letterSpacing = (-0.2).sp,
                        color = MaterialTheme.colorScheme.onSurface,
                    ),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    modifier = Modifier.fillMaxWidth(),
                    decorationBox = { field ->
                        Box {
                            if (title.isEmpty()) {
                                Text("Add a title", style = MaterialTheme.typography.headlineSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            field()
                        }
                    },
                )
                c.summary?.let { Text(it, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant) }

                val actions = full?.actions?.filter { it.state != "dismissed" }.orEmpty()
                if (actions.isNotEmpty()) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (a in actions) {
                            val done = a.state == "done"
                            val remindable = a.type in setOf("reminder", "todo") && (a.dueAt ?: 0) > System.currentTimeMillis()
                            val scheduled = remindable && a.state == "accepted"
                            AssistChip(
                                onClick = {
                                    if (remindable) {
                                        // Real reminder on this phone instead of punting to another app.
                                        Reminders.schedule(
                                            context,
                                            Reminder(a.id, c.id, a.type, a.label, a.payload, "accepted", a.dueAt!!, c.title),
                                        )
                                        scope.launch {
                                            vm.actionAccepted(a.id)
                                            full = full?.copy(actions = full?.actions?.map { if (it.id == a.id) it.copy(state = "accepted") else it })
                                            snackbar.showSnackbar("Reminder set for ${Reminders.formatDue(a.dueAt)}")
                                        }
                                    } else if (runAction(context, a)) {
                                        if (a.type == "copy") scope.launch { snackbar.showSnackbar("Copied") }
                                        scope.launch {
                                            vm.actionDone(a.id)
                                            full = full?.copy(actions = full?.actions?.map { if (it.id == a.id) it.copy(state = "done") else it })
                                        }
                                    }
                                },
                                label = { Text(if (remindable && !scheduled) "${a.label} · ${Reminders.formatDue(a.dueAt!!)}" else a.label) },
                                leadingIcon = {
                                    Icon(
                                        when {
                                            done -> Icons.Outlined.Check
                                            scheduled -> Icons.Outlined.AlarmOn
                                            else -> actionIcon(a.type)
                                        },
                                        null,
                                        Modifier.size(AssistChipDefaults.IconSize),
                                    )
                                },
                            )
                        }
                    }
                }

                // Facts the AI pulled out, plus the page it came from, in one card.
                val page = c.sourceUrl?.takeIf { it.startsWith("http") }
                val entities = c.entities.filterValues { it.isNotEmpty() }
                if (page != null || entities.isNotEmpty()) {
                    val ink = kind?.let { kindInk(it.hue) } ?: MaterialTheme.colorScheme.primary
                    Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
                        SelectionContainer {
                            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                page?.let { url ->
                                    Fact(Icons.Outlined.Public, "Page", ink) {
                                        Text(
                                            Uri.parse(url).host?.removePrefix("www.") ?: url,
                                            style = MaterialTheme.typography.bodyMedium.copy(textDecoration = TextDecoration.Underline),
                                            color = MaterialTheme.colorScheme.primary,
                                            modifier = Modifier.clickable {
                                                runCatching {
                                                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                                                }
                                            },
                                        )
                                    }
                                }
                                for ((key, values) in entities) {
                                    val (label, icon) = ENTITY_LABELS[key] ?: (key to Icons.AutoMirrored.Outlined.Label)
                                    Fact(icon, label, ink) { Text(values.joinToString("\n") { formatEntity(key, it) }, style = MaterialTheme.typography.bodyMedium) }
                                }
                            }
                        }
                    }
                }

                full?.let { f ->
                    PriceWatchRow(f) { on ->
                        scope.launch {
                            val updated = vm.patch(f.id, buildJsonObject { put("watch_price", on) })
                            if (updated != null) full = updated
                            else snackbar.showSnackbar("Couldn't change the price watch")
                        }
                    }
                }

                SectionLabel("Your note", Modifier.padding(top = 10.dp))
                BasicTextField(
                    value = note,
                    onValueChange = { note = it },
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    modifier = Modifier.fillMaxWidth(),
                    decorationBox = { field ->
                        Box(
                            Modifier
                                .fillMaxWidth()
                                .heightIn(min = 64.dp)
                                .clip(RoundedCornerShape(16.dp))
                                .background(MaterialTheme.colorScheme.surfaceContainerLow)
                                .padding(horizontal = 14.dp, vertical = 12.dp),
                        ) {
                            if (note.isEmpty()) {
                                Text("Why did you save this?", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            field()
                        }
                    },
                )

                SectionLabel("Collections", Modifier.padding(top = 10.dp))
                CollectionPicker(vm, listState.collections, full?.collections.orEmpty()) { ids ->
                    scope.launch {
                        val updated = vm.setCollections(c.id, ids)
                        if (updated != null) full = full?.copy(collections = updated.collections)
                        else snackbar.showSnackbar("Couldn't update collections")
                    }
                }

                SectionLabel("Tags", Modifier.padding(top = 10.dp))
                val currentTags = (full ?: c).tags
                fun saveTags(next: List<String>) {
                    scope.launch {
                        vm.patch(c.id, buildJsonObject { put("tags", JsonArray(next.map(::JsonPrimitive))) })?.let { full = it; capture = it }
                    }
                }
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                    itemVerticalAlignment = Alignment.CenterVertically,
                ) {
                    for (t in currentTags) {
                        InputChip(
                            selected = false,
                            onClick = { saveTags(currentTags - t) },
                            label = { Text(t) },
                            trailingIcon = { Icon(Icons.Outlined.Close, "Remove $t", Modifier.size(InputChipDefaults.IconSize)) },
                        )
                    }
                    BasicTextField(
                        value = newTag,
                        onValueChange = { v ->
                            // A comma finishes a tag, like the web.
                            if (v.endsWith(",")) {
                                val t = v.dropLast(1).trim().lowercase()
                                if (t.isNotEmpty() && t !in currentTags) saveTags(currentTags + t)
                                newTag = ""
                            } else newTag = v
                        },
                        singleLine = true,
                        textStyle = MaterialTheme.typography.bodyMedium.copy(color = MaterialTheme.colorScheme.onSurface),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = {
                            val t = newTag.trim().lowercase()
                            if (t.isNotEmpty() && t !in currentTags) saveTags(currentTags + t)
                            newTag = ""
                        }),
                        modifier = Modifier.widthIn(min = 96.dp).padding(vertical = 10.dp),
                        decorationBox = { field ->
                            Box {
                                if (newTag.isEmpty()) {
                                    Text(if (currentTags.isEmpty()) "Add a tag" else "Add", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                field()
                            }
                        },
                    )
                }

                c.ocrText?.let {
                    TextButton(onClick = { showText = !showText }, contentPadding = PaddingValues(horizontal = 0.dp)) {
                        Text(if (showText) "Hide text in the image" else "Show text in the image")
                    }
                    if (showText) SelectionContainer { Text(it, style = MaterialTheme.typography.bodySmall) }
                }
                c.model?.let { Text("Read by $it", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }

            // Expressive floating toolbar for capture actions.
            HorizontalFloatingToolbar(
                expanded = true,
                colors = FloatingToolbarDefaults.vibrantFloatingToolbarColors(),
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .navigationBarsPadding()
                    .padding(bottom = 16.dp),
            ) {
                if (c.deletedAt != null) {
                    IconButton(onClick = {
                        scope.launch {
                            vm.patch(c.id, buildJsonObject { put("deleted", false) })
                            vm.remove(c.id)
                            onBack()
                        }
                    }) { Icon(Icons.Outlined.RestoreFromTrash, "Restore") }
                    IconButton(onClick = { confirmPurge = true }) { Icon(Icons.Outlined.DeleteForever, "Delete forever") }
                } else {
                    FilledIconToggleButton(
                        checked = c.pinned,
                        onCheckedChange = { pin ->
                            scope.launch { vm.patch(c.id, buildJsonObject { put("pinned", pin) })?.let { capture = it; full = it } }
                        },
                    ) { Icon(if (c.pinned) Icons.Filled.PushPin else Icons.Outlined.PushPin, "Pin") }
                    IconButton(onClick = {
                        scope.launch {
                            vm.patch(c.id, buildJsonObject { put("archived", c.archivedAt == null) })
                            vm.remove(c.id)
                            onBack()
                        }
                    }) { Icon(if (c.archivedAt == null) Icons.Outlined.Archive else Icons.Outlined.Unarchive, "Archive") }
                    IconButton(onClick = {
                        scope.launch { vm.reprocess(c.id)?.let { capture = it } }
                    }) { Icon(Icons.Outlined.AutoAwesome, "Re-read with AI") }
                    IconButton(onClick = {
                        scope.launch {
                            vm.patch(c.id, buildJsonObject { put("deleted", true) })
                            vm.remove(c.id)
                            onBack()
                        }
                    }) { Icon(Icons.Outlined.Delete, "Move to trash") }
                }
            }
        }
    }

    if (confirmPurge && c != null) {
        AlertDialog(
            onDismissRequest = { confirmPurge = false },
            title = { Text("Delete forever?") },
            text = { Text("The screenshot and everything about it is gone for good.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmPurge = false
                    scope.launch { if (vm.purge(c.id)) onBack() }
                }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { confirmPurge = false }) { Text("Cancel") } },
        )
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun StatusBanner(icon: ImageVector?, text: String, error: Boolean) {
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.secondaryContainer,
        contentColor = if (error) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSecondaryContainer,
    ) {
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            if (icon != null) Icon(icon, null) else LoadingIndicator(Modifier.size(32.dp))
            Spacer(Modifier.width(12.dp))
            Text(text, style = MaterialTheme.typography.bodyMedium)
        }
    }
    Spacer(Modifier.height(0.dp))
}

/** The page a price watch checks: where it was captured, else the first link found in it. */
private fun watchableUrl(c: Capture): String? =
    c.sourceUrl?.takeIf { it.startsWith("http") } ?: c.entities["urls"].orEmpty().firstOrNull { it.startsWith("http") }

@Composable
private fun PriceWatchRow(c: Capture, onToggle: (Boolean) -> Unit) {
    val w = c.priceWatch
    // Offered for products, or anything with a price and a link to check.
    if (watchableUrl(c) == null || !(w != null || c.kind == "product" || c.entities["prices"].orEmpty().isNotEmpty())) return
    val status = when {
        w == null -> "Checks the page twice a day and tells you when the price drops."
        w.lastError != null -> "Last check failed: ${w.lastError}"
        w.lastPrice != null -> buildString {
            append("Now ${w.money(w.lastPrice)}")
            w.lowestPrice?.takeIf { it < w.lastPrice }?.let { append(" · lowest ${w.money(it)}") }
            w.firstPrice?.takeIf { it != w.lastPrice }?.let { append(" · was ${w.money(it)}") }
            w.lastCheckedAt?.let { append(" · checked ${relativeDay(it).lowercase()} ${timeOf(it)}") }
        }
        else -> "Watching. First check is on its way."
    }
    Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.AutoMirrored.Outlined.TrendingDown, null, tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text("Watch price", style = MaterialTheme.typography.titleSmall)
                Text(status, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.width(12.dp))
            Switch(checked = w != null, onCheckedChange = onToggle)
        }
    }
}

@Composable
private fun Fact(icon: ImageVector, label: String, ink: androidx.compose.ui.graphics.Color, value: @Composable () -> Unit) {
    Row(verticalAlignment = Alignment.Top) {
        Icon(icon, null, Modifier.size(20.dp), tint = ink)
        Spacer(Modifier.width(10.dp))
        Text(label, Modifier.width(64.dp), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        Box(Modifier.weight(1f)) { value() }
    }
}

/** Dates read as dates, links without the https://www. noise. */
private fun formatEntity(key: String, value: String): String = when (key) {
    "dates" -> runCatching {
        if (value.length <= 10) {
            java.time.LocalDate.parse(value).format(java.time.format.DateTimeFormatter.ofLocalizedDate(java.time.format.FormatStyle.MEDIUM))
        } else {
            java.time.OffsetDateTime.parse(value).atZoneSameInstant(java.time.ZoneId.systemDefault())
                .format(java.time.format.DateTimeFormatter.ofLocalizedDateTime(java.time.format.FormatStyle.MEDIUM, java.time.format.FormatStyle.SHORT))
        }
    }.getOrDefault(value)
    "urls" -> value.removePrefix("https://").removePrefix("http://").removePrefix("www.")
    else -> value
}
