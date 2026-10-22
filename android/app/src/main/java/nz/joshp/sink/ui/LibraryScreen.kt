package nz.joshp.sink.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.CreateNewFolder
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/** Library tab: the places that aren't the main grid. Same list as the web sidebar. */
@Composable
fun LibraryScreen(vm: SinkViewModel, onView: (View) -> Unit, onCollection: (String) -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    var creating by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { vm.loadCollections() }

    Column(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.surfaceContainerLowest)
            .statusBarsPadding()
            .verticalScroll(rememberScrollState())
            .padding(bottom = 24.dp),
    ) {
        ScreenTitle("Library")
        Group {
            Entry(Icons.Outlined.PushPin, "Pinned") { onView(View.Pinned) }
            Entry(Icons.Outlined.Archive, "Archive") { onView(View.Archived) }
            Entry(Icons.Outlined.Delete, "Trash") { onView(View.Trash) }
        }
        SectionLabel("Collections", Modifier.padding(start = 28.dp, top = 24.dp, bottom = 8.dp))
        Group {
            for (c in state.collections) Entry(Icons.Outlined.Folder, c.name, count = c.count) { onCollection(c.id) }
            Entry(Icons.Outlined.CreateNewFolder, "New collection", accent = true) { creating = true }
        }
        if (state.collections.isEmpty()) {
            Text(
                "Group captures for a trip, a gift list, anything.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 28.dp, vertical = 10.dp),
            )
        }
    }

    if (creating) {
        NameDialog("New collection", "", onDismiss = { creating = false }) { name ->
            vm.createCollection(name).map { onCollection(it.id) }
        }
    }
}

@Composable
private fun Group(content: @Composable () -> Unit) {
    Surface(
        shape = RoundedCornerShape(24.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
    ) { Column(Modifier.padding(vertical = 6.dp)) { content() } }
}

@Composable
private fun Entry(icon: ImageVector, label: String, count: Int? = null, accent: Boolean = false, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(36.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(if (accent) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.secondaryContainer),
            Alignment.Center,
        ) {
            Icon(
                icon,
                null,
                Modifier.size(20.dp),
                tint = if (accent) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSecondaryContainer,
            )
        }
        Spacer(Modifier.width(16.dp))
        Text(
            label,
            style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium),
            color = if (accent) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f),
        )
        count?.let { Text("$it", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

/** Small caps section label, same as the web's. */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Bold, letterSpacing = MaterialTheme.typography.labelMedium.letterSpacing * 2),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier,
    )
}
