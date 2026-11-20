package nz.joshp.sink.ui

import kotlinx.serialization.json.Json

internal fun readEditorText(
    current: () -> String,
    evaluate: (String, (String?) -> Unit) -> Unit,
    then: (String) -> Unit,
) {
    // Native text can be ready before the web editor exists; keep it until the editor has real text to read.
    evaluate("window.sink.textOrNull()") { raw ->
        val text = raw?.let { runCatching { Json.decodeFromString<String>(it) }.getOrNull() }
        then(text ?: current())
    }
}
