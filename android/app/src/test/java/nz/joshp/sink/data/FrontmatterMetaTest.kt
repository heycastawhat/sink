package nz.joshp.sink.data

import org.junit.Assert.assertEquals
import org.junit.Test

class FrontmatterMetaTest {
    @Test
    fun readsPinAndColourFromFrontmatter() {
        val text = "---\npinned: true\ncolor: blue\n---\n# Note\n\nBody\n"
        assertEquals(FrontmatterMeta(pinned = true, color = "blue"), frontmatterMeta(text))
    }

    @Test
    fun clearsPinAndColourWhenFrontmatterIsRemoved() {
        assertEquals(FrontmatterMeta(pinned = false, color = null), frontmatterMeta("# Note\n\nBody\n"))
    }

    @Test
    fun handlesQuotedCaseInsensitiveAndCrlfFrontmatter() {
        val text = "\uFEFF---\r\npinned: \"YES\"\r\ncolor: 'Green'\r\n---   \r\nBody\r\n"
        assertEquals(FrontmatterMeta(pinned = true, color = "green"), frontmatterMeta(text))
    }

    @Test
    fun ignoresInvalidColoursAndFalsyPinnedValues() {
        val text = "---\npinned: false\ncolor: chartreuse\n---\nBody\n"
        assertEquals(FrontmatterMeta(pinned = false, color = null), frontmatterMeta(text))
    }

    @Test
    fun tracksTransitionsWhenRemoteMetaChanges() {
        val initial = "# Project\n\nChecklist\n"
        val pinnedBlue = "---\npinned: true\ncolor: blue\n---\n# Project\n\nChecklist\nPWA_METADATA_SYNC\n"
        val unpinnedGreen = "---\ncolor: green\n---\n# Project\n\nChecklist\nPWA_METADATA_SYNC\n"
        assertEquals(FrontmatterMeta(pinned = false, color = null), frontmatterMeta(initial))
        assertEquals(FrontmatterMeta(pinned = true, color = "blue"), frontmatterMeta(pinnedBlue))
        assertEquals(FrontmatterMeta(pinned = false, color = "green"), frontmatterMeta(unpinnedGreen))
    }
}
