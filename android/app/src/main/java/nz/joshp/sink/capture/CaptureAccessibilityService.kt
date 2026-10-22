package nz.joshp.sink.capture

import android.accessibilityservice.AccessibilityButtonController
import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.widget.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import nz.joshp.sink.ui.CaptureActivity

/**
 * The Essential Key. Takes a screenshot with no MediaProjection prompt, then opens the note sheet.
 * Triggered by the accessibility button (floating or nav bar) or the Stash Quick Settings tile.
 * It never reads window content; it only watches which app is in front so the capture can say where it came from.
 */
class CaptureAccessibilityService : AccessibilityService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val main = Handler(Looper.getMainLooper())
    private var foregroundPackage: String? = null

    private val buttonCallback = object : AccessibilityButtonController.AccessibilityButtonCallback() {
        override fun onClicked(controller: AccessibilityButtonController) = capture(delayMs = 150)
    }

    override fun onServiceConnected() {
        instance = this
        accessibilityButtonController.registerAccessibilityButtonCallback(buttonCallback)
        // The floating button only shows when asked for; the tile works either way.
        scope.launch {
            nz.joshp.sink.data.Settings(this@CaptureAccessibilityService).floatingButton.collect { on ->
                serviceInfo = serviceInfo.apply {
                    flags = if (on) flags or AccessibilityServiceInfo.FLAG_REQUEST_ACCESSIBILITY_BUTTON
                    else flags and AccessibilityServiceInfo.FLAG_REQUEST_ACCESSIBILITY_BUTTON.inv()
                }
            }
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            val pkg = event.packageName?.toString() ?: return
            // The keyboard and system UI open windows too; they're never what you screenshotted.
            val ime = Settings.Secure.getString(contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)?.substringBefore('/')
            if (pkg != packageName && pkg != "com.android.systemui" && pkg != ime) foregroundPackage = pkg
        }
    }

    override fun onInterrupt() = Unit

    override fun onDestroy() {
        accessibilityButtonController.unregisterAccessibilityButtonCallback(buttonCallback)
        instance = null
        scope.cancel()
        super.onDestroy()
    }

    /** Closes the shade first when called from the tile, so it isn't in the shot. */
    fun capture(delayMs: Long, closeShade: Boolean = false) {
        if (closeShade) performGlobalAction(GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE)
        main.postDelayed({
            takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
                override fun onSuccess(result: ScreenshotResult) {
                    val hw = Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace)
                    val bitmap = hw?.copy(Bitmap.Config.ARGB_8888, false)
                    result.hardwareBuffer.close()
                    if (bitmap == null) return toast("Couldn't grab the screen")
                    val source = foregroundPackage
                    scope.launch {
                        val staged = CaptureQueue.stage(this@CaptureAccessibilityService, bitmap)
                        bitmap.recycle()
                        startActivity(CaptureActivity.forStaged(this@CaptureAccessibilityService, staged, "tile", source))
                    }
                }

                override fun onFailure(errorCode: Int) = toast("Screenshot failed ($errorCode)")
            })
        }, delayMs)
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    companion object {
        @Volatile
        var instance: CaptureAccessibilityService? = null
            private set

        fun isEnabled(context: Context): Boolean {
            val enabled = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
            val me = ComponentName(context, CaptureAccessibilityService::class.java).flattenToString()
            return enabled.split(':').any { it.equals(me, ignoreCase = true) }
        }

        fun settingsIntent() = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
