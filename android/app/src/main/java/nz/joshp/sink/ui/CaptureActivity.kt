package nz.joshp.sink.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.speech.RecognizerIntent
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.core.content.IntentCompat
import coil3.compose.AsyncImage
import kotlinx.coroutines.launch
import nz.joshp.sink.SinkApp
import nz.joshp.sink.capture.CaptureQueue
import nz.joshp.sink.capture.Staged
import nz.joshp.sink.data.Session
import nz.joshp.sink.ui.theme.SinkTheme
import java.io.File

/**
 * The "why did you save this?" sheet. Opens over whatever app you were in, for shares and
 * for the Stash button. Dismissing still stashes; only Discard throws it away.
 */
class CaptureActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = application as SinkApp
        val source = intent.getStringExtra(EXTRA_SOURCE) ?: "share"
        val appPackage = intent.getStringExtra(EXTRA_APP) ?: referrer?.host?.takeIf { it != packageName }
        val preStaged = intent.getStringExtra(EXTRA_PATH)?.let {
            Staged(it, intent.getStringExtra(EXTRA_MIME) ?: "image/png", intent.getLongExtra(EXTRA_AT, System.currentTimeMillis()))
        }
        val uris = sharedUris(intent)

        setContent {
            val dynamic by app.settings.dynamicColor.collectAsState(initial = false)
            val session by app.settings.session.collectAsState(initial = Session("", ""))
            SinkTheme(dynamicColor = dynamic) {
                if (session == null) {
                    LaunchedEffect(Unit) {
                        Toast.makeText(this@CaptureActivity, "Log in to Sink first", Toast.LENGTH_LONG).show()
                        preStaged?.let(CaptureQueue::discard)
                        finish()
                    }
                } else {
                    NoteSheet(preStaged, uris, onDone = { staged, note, keep ->
                        if (keep) staged.forEach { CaptureQueue.enqueue(this, it, note, source, appPackage) }
                        else staged.forEach(CaptureQueue::discard)
                        if (keep && staged.isNotEmpty()) {
                            Toast.makeText(this, if (staged.size == 1) "Stashed" else "Stashed ${staged.size}", Toast.LENGTH_SHORT).show()
                        }
                        finish()
                    })
                }
            }
        }
    }

    private fun sharedUris(intent: Intent): List<Uri> = when (intent.action) {
        Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
        Intent.ACTION_SEND_MULTIPLE ->
            IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
        else -> emptyList()
    }

    companion object {
        private const val EXTRA_PATH = "staged_path"
        private const val EXTRA_MIME = "staged_mime"
        private const val EXTRA_AT = "staged_at"
        private const val EXTRA_SOURCE = "source"
        private const val EXTRA_APP = "app_package"

        fun forStaged(context: Context, staged: Staged, source: String, appPackage: String?) =
            Intent(context, CaptureActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                .putExtra(EXTRA_PATH, staged.path)
                .putExtra(EXTRA_MIME, staged.mime)
                .putExtra(EXTRA_AT, staged.capturedAt)
                .putExtra(EXTRA_SOURCE, source)
                .putExtra(EXTRA_APP, appPackage)
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun NoteSheet(preStaged: Staged?, uris: List<Uri>, onDone: (List<Staged>, String?, Boolean) -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val staged = remember { mutableStateListOf<Staged>().apply { preStaged?.let(::add) } }
    var staging by remember { mutableStateOf(uris.isNotEmpty()) }
    var note by rememberSaveable { mutableStateOf("") }
    var finished by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }

    // Copy shared images into app storage straight away; the share grant can expire.
    LaunchedEffect(uris) {
        for (uri in uris.take(20)) {
            runCatching { CaptureQueue.stage(context, uri) }.getOrNull()?.let(staged::add)
        }
        staging = false
        if (staged.isEmpty()) {
            Toast.makeText(context, "Couldn't read that image", Toast.LENGTH_SHORT).show()
            onDone(emptyList(), null, false)
        }
    }

    val speech = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val heard = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
        if (!heard.isNullOrBlank()) note = if (note.isBlank()) heard else "$note $heard"
    }

    fun finish(keep: Boolean) {
        if (finished) return
        finished = true
        scope.launch {
            sheet.hide()
            onDone(staged.toList(), note.trim().ifBlank { null }, keep)
        }
    }

    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    ModalBottomSheet(
        onDismissRequest = { finish(keep = true) },
        sheetState = sheet,
        containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .imePadding()
                .navigationBarsPadding()
                .padding(horizontal = 24.dp)
                .padding(bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("Why are you saving this?", style = MaterialTheme.typography.headlineSmall)

            if (staging && staged.isEmpty()) {
                Box(Modifier.fillMaxWidth().height(160.dp), Alignment.Center) { LoadingIndicator() }
            } else {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(staged, key = { it.path }) { s ->
                        AsyncImage(
                            model = File(s.path),
                            contentDescription = null,
                            contentScale = ContentScale.Crop,
                            alignment = Alignment.TopCenter,
                            modifier = Modifier
                                .height(180.dp)
                                .width(if (staged.size == 1) 120.dp else 96.dp)
                                .clip(RoundedCornerShape(20.dp))
                                .background(MaterialTheme.colorScheme.surfaceContainerHighest),
                        )
                    }
                }
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    placeholder = { Text("e.g. book this before Friday") },
                    minLines = 1,
                    maxLines = 4,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { finish(keep = true) }),
                    shape = RoundedCornerShape(20.dp),
                    modifier = Modifier
                        .weight(1f)
                        .focusRequester(focus),
                )
                Spacer(Modifier.width(8.dp))
                FilledTonalIconButton(
                    onClick = {
                        runCatching {
                            speech.launch(
                                Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                                    .putExtra(RecognizerIntent.EXTRA_PROMPT, "Why are you saving this?")
                                    .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true),
                            )
                        }.onFailure { Toast.makeText(context, "No voice input on this phone", Toast.LENGTH_SHORT).show() }
                    },
                    modifier = Modifier.size(IconButtonDefaults.mediumContainerSize()),
                    shapes = IconButtonDefaults.shapes(),
                ) { Icon(Icons.Outlined.Mic, "Speak a note") }
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { finish(keep = false) }) { Text("Discard") }
                Spacer(Modifier.weight(1f))
                Button(
                    onClick = { finish(keep = true) },
                    enabled = staged.isNotEmpty(),
                    modifier = Modifier.height(56.dp),
                ) { Text(if (note.isBlank()) "Stash without note" else "Stash", style = MaterialTheme.typography.titleMedium) }
            }
        }
    }
}
