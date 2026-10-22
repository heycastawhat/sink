package nz.joshp.sink.capture

import android.app.assist.AssistContent
import android.app.assist.AssistStructure
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.speech.RecognitionService
import android.service.voice.VoiceInteractionService
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import android.widget.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import nz.joshp.sink.ui.CaptureActivity

/**
 * Sink as the default digital assistant: hold power (or swipe from a bottom corner) to stash the screen.
 * Android hands the assistant a screenshot plus the real text on screen and, from browsers, the page URL —
 * better than OCR, and no floating button. Users pick it in Settings > Apps > Default apps > Digital assistant.
 */
class SinkAssistantService : VoiceInteractionService()

class SinkAssistantSessionService : VoiceInteractionSessionService() {
    override fun onNewSession(args: Bundle?): VoiceInteractionSession = SinkAssistSession(this)
}

/** Required by the framework for an assistant to be selectable; Sink doesn't do voice recognition. */
class SinkRecognitionService : RecognitionService() {
    override fun onStartListening(recognizerIntent: Intent?, listener: Callback?) {
        listener?.error(android.speech.SpeechRecognizer.ERROR_CLIENT)
    }

    override fun onCancel(listener: Callback?) = Unit
    override fun onStopListening(listener: Callback?) = Unit
}

class SinkAssistSession(context: Context) : VoiceInteractionSession(context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var screenshot: Bitmap? = null
    private var screenshotArrived = false
    private val text = StringBuilder()
    private var url: String? = null
    private var appPackage: String? = null
    private var pending: Job? = null

    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        screenshot = null
        screenshotArrived = false
        text.clear()
        url = null
        appPackage = null
        // Screenshot and structure arrive separately; give them a moment, then go with what we have.
        pending?.cancel()
        pending = scope.launch {
            delay(WAIT_MS)
            stash()
        }
    }

    override fun onHandleAssist(state: AssistState) {
        state.assistStructure?.let { structure ->
            appPackage = structure.activityComponent?.packageName
            for (i in 0 until structure.windowNodeCount) collect(structure.getWindowNodeAt(i).rootViewNode)
        }
        state.assistContent?.let(::collect)
        maybeFinish()
    }

    override fun onHandleScreenshot(bitmap: Bitmap?) {
        screenshot = bitmap?.copy(Bitmap.Config.ARGB_8888, false)
        screenshotArrived = true
        maybeFinish()
    }

    private fun collect(content: AssistContent) {
        url = url ?: content.webUri?.toString()
    }

    private fun collect(node: AssistStructure.ViewNode?) {
        if (node == null || text.length > MAX_TEXT) return
        // Skip password fields: assistants can see them, Sink shouldn't keep them.
        val isPassword = node.inputType and android.text.InputType.TYPE_MASK_VARIATION in PASSWORD_VARIATIONS
        if (!isPassword) {
            node.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { text.appendLine(it) }
                ?: node.contentDescription?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { text.appendLine(it) }
        }
        node.webDomain?.let { domain -> if (url == null) url = "https://$domain" }
        for (i in 0 until node.childCount) collect(node.getChildAt(i))
    }

    private fun maybeFinish() {
        // The screenshot is the slow part; once it's here the structure has normally arrived too.
        if (screenshotArrived) {
            pending?.cancel()
            pending = scope.launch {
                delay(150)
                stash()
            }
        }
    }

    private fun stash() {
        val bitmap = screenshot
        if (bitmap == null) {
            Toast.makeText(
                context,
                "Sink didn't get a screenshot. Turn on \"Use screenshot\" in Digital assistant settings.",
                Toast.LENGTH_LONG,
            ).show()
            hide()
            return
        }
        val screenText = text.toString().trim().ifEmpty { null }
        val sourceUrl = url
        val pkg = appPackage
        scope.launch {
            val staged = CaptureQueue.stage(context, bitmap)
            CaptureQueue.attachScreenContext(staged, screenText, sourceUrl)
            startAssistantActivity(CaptureActivity.forStaged(context, staged, "assist", pkg), Bundle())
            hide()
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val WAIT_MS = 2500L
        private const val MAX_TEXT = 40_000
        private val PASSWORD_VARIATIONS = setOf(
            android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD,
            android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD,
            android.text.InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD,
            android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD,
        )
    }
}
