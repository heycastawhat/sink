package nz.joshp.sink.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.widget.Toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.PictureAsPdf
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * A PDF filed in a folder, page by page, drawn by Android's own PdfRenderer (no library, no Play services). "Open in"
 * hands it to another app for zooming, annotating or printing.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun PdfScreen(vm: NotesViewModel, path: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val file by produceState<Result<File>?>(null, path) { value = vm.pdfFile(path) }
    Column(
        Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceContainerLowest).statusBarsPadding(),
    ) {
        ScreenTitle(
            path.substringAfterLast('/').removeSuffix(".pdf").removeSuffix(".PDF"),
            sub = path.substringBeforeLast('/', "").ifEmpty { null },
            onBack = onBack,
        ) {
            file?.getOrNull()?.let { f -> IconButton(onClick = { openElsewhere(context, f) }) { Icon(Icons.AutoMirrored.Outlined.OpenInNew, "Open in another app") } }
        }
        val f = file
        when {
            f == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { LoadingIndicator() }
            f.isFailure -> EmptyState("Can't open this PDF", f.exceptionOrNull()?.message.orEmpty(), Icons.Outlined.CloudOff)
            else -> Pages(f.getOrThrow())
        }
    }
}

@Composable
private fun Pages(file: File) {
    val renderer = remember(file) { runCatching { PdfRenderer(ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)) }.getOrNull() }
    // PdfRenderer allows one open page at a time, so every use (sizes, drawing, closing) holds its lock.
    DisposableEffect(renderer) { onDispose { renderer?.let { synchronized(it) { it.close() } } } }
    if (renderer == null) return EmptyState("Can't read this PDF", "It may be damaged or need a password. Try opening it in another app.", Icons.Outlined.PictureAsPdf)
    val sizes = remember(renderer) {
        synchronized(renderer) { (0 until renderer.pageCount).map { i -> renderer.openPage(i).use { it.width.toFloat() / it.height } } }
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val width = constraints.maxWidth
        LazyColumn(
            contentPadding = PaddingValues(start = 12.dp, end = 12.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.fillMaxSize().navigationBarsPadding(),
        ) {
            items(sizes.size) { i ->
                val page by produceState<ImageBitmap?>(null, renderer, i, width) { value = withContext(Dispatchers.IO) { render(renderer, i, width) } }
                Box(
                    Modifier.fillMaxWidth().aspectRatio(sizes[i]).clip(RoundedCornerShape(4.dp)).background(Color.White),
                ) {
                    page?.let { Image(it, "Page ${i + 1}", Modifier.fillMaxSize()) }
                }
            }
        }
    }
}

/** Page [i] at [width] pixels across; null once the screen has closed the file. */
private fun render(renderer: PdfRenderer, i: Int, width: Int): ImageBitmap? = runCatching {
    synchronized(renderer) {
        renderer.openPage(i).use { page ->
            val bitmap = Bitmap.createBitmap(width, (width.toLong() * page.height / page.width).toInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(android.graphics.Color.WHITE)
            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            bitmap.asImageBitmap()
        }
    }
}.getOrNull()

private fun openElsewhere(context: Context, file: File) {
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/pdf").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    try {
        context.startActivity(Intent.createChooser(view, null))
    } catch (_: ActivityNotFoundException) {
        Toast.makeText(context, "No app here opens PDFs", Toast.LENGTH_SHORT).show()
    }
}
