package nz.joshp.sink.ui

import android.util.Size
import androidx.activity.compose.BackHandler
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * A fullscreen QR scanner: the camera preview, with each frame decoded on the phone by ZXing. Nothing here needs
 * Google Play services (the scanner it replaced did), so it works on phones without them. The caller asks for the
 * camera permission before showing it.
 */
@Composable
fun QrScanner(onCode: (String) -> Unit, onError: (String) -> Unit, onClose: () -> Unit) {
    val context = LocalContext.current
    val owner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    val currentOnCode by rememberUpdatedState(onCode)
    val currentOnError by rememberUpdatedState(onError)
    val previewView = remember { PreviewView(context) }
    BackHandler(onBack = onClose)

    DisposableEffect(owner) {
        val decoder = Executors.newSingleThreadExecutor()
        val main = ContextCompat.getMainExecutor(context)
        val future = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null
        var disposed = false
        // Only the first code is reported; frames keep arriving until the screen closes.
        val found = AtomicBoolean(false)
        future.addListener({
            if (disposed) return@addListener
            try {
                val cameras = future.get()
                provider = cameras
                val preview = Preview.Builder().build()
                preview.setSurfaceProvider(previewView.surfaceProvider)
                // The default 640x480 is too coarse for a dense code held at arm's length.
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setResolutionSelector(
                        ResolutionSelector.Builder()
                            .setResolutionStrategy(
                                ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER),
                            )
                            .build(),
                    )
                    .build()
                analysis.setAnalyzer(decoder) { image ->
                    val text = try {
                        decodeQr(image)
                    } finally {
                        image.close()
                    }
                    if (text != null && found.compareAndSet(false, true)) main.execute { currentOnCode(text) }
                }
                cameras.unbindAll()
                cameras.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            } catch (e: Exception) {
                currentOnError("Couldn't open the camera")
            }
        }, main)
        onDispose {
            disposed = true
            provider?.unbindAll()
            decoder.shutdown()
        }
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())
        IconButton(onClick = onClose, modifier = Modifier.align(Alignment.TopStart).statusBarsPadding().padding(8.dp)) {
            Icon(Icons.Filled.Close, "Close", tint = Color.White)
        }
        Text(
            "Point the camera at the code in Settings → Signed-in devices",
            style = MaterialTheme.typography.bodyLarge,
            color = Color.White,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                .padding(24.dp)
                .background(Color.Black.copy(alpha = 0.55f), MaterialTheme.shapes.large)
                .padding(horizontal = 16.dp, vertical = 10.dp),
        )
    }
}

private val qrHints = mapOf(DecodeHintType.TRY_HARDER to true)

/** The QR code's text in a camera frame, or null. Only the brightness plane is read; a QR code decodes at any rotation. */
private fun decodeQr(image: ImageProxy): String? {
    val plane = image.planes[0]
    val width = image.width
    val height = image.height
    val buffer = plane.buffer
    val stride = plane.rowStride
    val pixels = ByteArray(width * height)
    // Rows can be padded past the image width.
    if (stride == width) {
        buffer.get(pixels, 0, minOf(buffer.remaining(), pixels.size))
    } else {
        for (row in 0 until height) {
            buffer.position(row * stride)
            buffer.get(pixels, row * width, minOf(width, buffer.remaining()))
        }
    }
    val source = PlanarYUVLuminanceSource(pixels, width, height, 0, 0, width, height, false)
    val reader = QRCodeReader()
    // A dark-mode page can show the code light on dark, so try the inverted frame too.
    for (candidate in listOf(source, source.invert())) {
        try {
            return reader.decode(BinaryBitmap(HybridBinarizer(candidate)), qrHints).text
        } catch (e: ReaderException) {
            // No code in this frame.
        }
    }
    return null
}
