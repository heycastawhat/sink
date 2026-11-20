package nz.joshp.sink.ui

import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class EditorTextTest {
    private val pinned = "---\npinned: true\n---\n# Phone note\n\nRemember to walk today.\n"

    private fun read(page: String?, native: String): String {
        var result = native
        readEditorText({ native }, { script, done ->
            done(when (script) {
                "window.sink.getText()" -> JsonPrimitive(page ?: "").toString()
                "window.sink.textOrNull()" -> page?.let { JsonPrimitive(it).toString() } ?: "null"
                else -> error("Unexpected editor read: $script")
            })
        }) { result = it }
        return result
    }

    @Test
    fun unloadedEditorKeepsOriginalNoteAndPin() {
        assertEquals(pinned, read(null, pinned))
    }

    @Test
    fun unloadedEditorKeepsNativePendingText() {
        val pending = pinned + "Unsynced edit\n"
        assertEquals(pending, read(null, pending))
    }

    @Test
    fun loadedEditorReturnsLatestText() {
        val edited = pinned + "Buy milk\n"
        assertEquals(edited, read(edited, pinned))
    }

    @Test
    fun loadedEditorCanBeDeliberatelyEmptied() {
        assertEquals("", read("", pinned))
    }

    @Test
    fun literalNullTextIsNotAnUnloadedEditor() {
        assertEquals("null", read("null", pinned))
    }

    @Test
    fun failedReadsKeepNativeText() {
        for (raw in listOf(null, "null", "undefined", "{\"error\":\"not ready\"}")) {
            var result = ""
            readEditorText({ pinned }, { _, done -> done(raw) }) { result = it }
            assertEquals(pinned, result)
        }
    }

    @Test
    fun fallbackUsesPendingTextAtCallbackTime() {
        var native = pinned
        var reply: ((String?) -> Unit)? = null
        var result = ""
        readEditorText({ native }, { _, done -> reply = done }) { result = it }
        native += "Edit received while reading\n"
        reply!!("null")
        assertEquals(native, result)
    }
}
