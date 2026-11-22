package nz.joshp.sink.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class EditorLoadTest {
    private val original = "---\ncolor: green\n---\n# Phone note\n"

    @Test
    fun metadataChangedBeforePageReadyIsUsedWhenThePageLoads() {
        for (current in listOf(
            "---\ncolor: green\npinned: true\n---\n# Phone note\n",
            "---\ncolor: blue\n---\n# Phone note\n",
        )) {
            assertNull(editorLoadText(false, original, current))
            assertEquals(current, editorLoadText(true, original, current))
        }
    }

    @Test
    fun latestNativePendingEditsAreNotReplacedByTheInitialPayload() {
        val pending = original + "Unsynced edit\n"
        assertEquals(pending, editorLoadText(true, original, pending))
    }

    @Test
    fun currentEmptyTextIsNotReplacedByTheInitialPayload() {
        assertEquals("", editorLoadText(true, original, ""))
        assertEquals("", editorLoadText(true, "", ""))
    }

    @Test
    fun bothThePageAndNativeNoteMustBeReady() {
        assertNull(editorLoadText(false, original, original))
        assertNull(editorLoadText(true, null, original))
        assertEquals(original, editorLoadText(true, original, original))
    }
}
