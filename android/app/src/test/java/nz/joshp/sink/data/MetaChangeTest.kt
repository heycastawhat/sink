package nz.joshp.sink.data

import org.junit.Assert.assertEquals
import org.junit.Test

class MetaChangeTest {
    @Test
    fun offlineChangesCanBeSavedTogetherWithoutLosingUnpinOrClearColour() {
        val merged = MetaChange(true, "blue")
            .then(MetaChange(pinned = false))
            .then(MetaChange(clearColor = true))
        val restored = json.decodeFromString<MetaChange>(json.encodeToString(MetaChange.serializer(), merged))
        assertEquals(MetaChange(pinned = false, clearColor = true), restored)
        assertEquals(MetaChange(pinned = false, color = "green"), restored.then(MetaChange(color = "green")))
    }
}
