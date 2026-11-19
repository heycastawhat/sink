package nz.joshp.sink.data

import org.junit.Assert.assertEquals
import org.junit.Test

class TextAfterMetaTest {
    private val yellowPinned = "---\npinned: true\ncolor: yellow\n---\nShopping\n"
    private val greenPinned = "---\npinned: true\ncolor: green\n---\nShopping\n"
    private val greenUnpinned = "---\ncolor: green\n---\nShopping\n"

    @Test
    fun untouchedEditorTakesTheServersText() {
        assertEquals(greenPinned, textAfterMeta(yellowPinned, yellowPinned, greenPinned))
    }

    // The reported bug: set green, then unpin, without leaving the note. Each change must start from the last one,
    // never from the text the note was opened with.
    @Test
    fun pinAndColourChangesDoNotUndoEachOther() {
        var editor = yellowPinned
        var saved = yellowPinned
        for (server in listOf(greenPinned, greenUnpinned, greenUnpinned)) {
            editor = textAfterMeta(editor, saved, server)
            saved = server
            assertEquals(server, editor)
        }
    }

    @Test
    fun typedTextKeepsItsBodyUnderTheNewFrontmatter() {
        val typed = "---\npinned: true\ncolor: yellow\n---\nShopping\nmilk\n"
        assertEquals("---\npinned: true\ncolor: green\n---\nShopping\nmilk\n", textAfterMeta(typed, yellowPinned, greenPinned))
    }

    @Test
    fun frontmatterAddedAndRemoved() {
        assertEquals("---\ncolor: red\n---\nhi there", textAfterMeta("hi there", "hi", "---\ncolor: red\n---\nhi"))
        assertEquals("hi there", textAfterMeta("---\ncolor: red\n---\nhi there", "---\ncolor: red\n---\nhi", "hi"))
    }
}
