package nz.joshp.sink.ui

import android.annotation.SuppressLint
import android.content.Context
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.ViewConfiguration
import android.webkit.WebView
import androidx.activity.BackEventCompat
import androidx.activity.OnBackPressedDispatcher
import kotlin.math.abs

/**
 * Pulling a note down from its top closes it, as a back gesture would: the drag is fed to the back dispatcher as a
 * predictive back, so the note shrinks (back into the card it came from, if there is one) under the finger exactly as
 * it does for a swipe from the edge, and letting go far enough (or with a flick) completes it.
 */
class PullDownToClose(
    private val dispatcher: () -> OnBackPressedDispatcher?,
    /** How far the finger has to travel, in px, for the gesture's whole length. */
    private val travel: () -> Float,
    /** Whether a pull can start now (not with the keyboard up, not on a board). */
    val enabled: () -> Boolean,
) {
    private var progress = 0f

    internal fun start() {
        val d = dispatcher() ?: return
        BackMotion.downward = true
        progress = 0f
        d.dispatchOnBackStarted(event(0f))
    }

    /** The finger is [dy] px below where the pull started. */
    internal fun move(dy: Float) {
        val d = dispatcher() ?: return
        progress = (dy / travel()).coerceIn(0f, 1f)
        d.dispatchOnBackProgressed(event(progress))
    }

    /** The finger's gone, moving down at [speed] px/s. */
    internal fun end(speed: Float) {
        val d = dispatcher() ?: return
        if (progress >= COMMIT || (speed > FLICK && progress > 0.05f)) d.onBackPressed() else d.dispatchOnBackCancelled()
        BackMotion.downward = false
    }

    internal fun cancel() {
        dispatcher()?.dispatchOnBackCancelled()
        BackMotion.downward = false
    }

    private fun event(progress: Float) = BackEventCompat(0f, 0f, progress, BackEventCompat.EDGE_LEFT)

    private companion object {
        /** Let go past this much of the gesture and the note closes. */
        const val COMMIT = 0.3f
        /** A flick down this fast (px/s) closes it from anywhere. */
        const val FLICK = 1200f
    }
}

/**
 * The note's WebView, which hands a downward drag that starts with the page scrolled to its top to [pullDown] (instead
 * of overscrolling); anything else (scrolling, selecting, a sideways drag) is the page's as usual.
 */
@SuppressLint("ViewConstructor")
class NoteWebView(context: Context) : WebView(context) {
    var pullDown: PullDownToClose? = null

    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private var downX = 0f
    private var downY = 0f
    /** This touch began at the page's top and hasn't yet gone any way but down. */
    private var candidate = false
    private var pulling = false
    private var velocity: VelocityTracker? = null

    @SuppressLint("ClickableViewAccessibility")
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        val pull = pullDown ?: return super.dispatchTouchEvent(ev)
        // Raw coordinates: the page itself shrinks and moves as the pull goes on.
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = ev.rawX
                downY = ev.rawY
                candidate = scrollY == 0 && pull.enabled()
                pulling = false
                velocity?.recycle()
                velocity = VelocityTracker.obtain()
            }
            MotionEvent.ACTION_POINTER_DOWN -> if (!pulling) candidate = false
            MotionEvent.ACTION_MOVE -> if (candidate && !pulling) {
                val dy = ev.rawY - downY
                val dx = abs(ev.rawX - downX)
                if (dy > slop && dy > dx * 1.5f) {
                    pulling = true
                    // The page lets go of the touch (no selection or tap from it), and the pull takes over from here.
                    downY += slop
                    val cancel = MotionEvent.obtain(ev).apply { action = MotionEvent.ACTION_CANCEL }
                    super.dispatchTouchEvent(cancel)
                    cancel.recycle()
                    pull.start()
                } else if (dy < -slop || dx > slop) candidate = false
            }
        }
        velocity?.let { v ->
            val raw = MotionEvent.obtain(ev).apply { setLocation(ev.rawX, ev.rawY) }
            v.addMovement(raw)
            raw.recycle()
        }
        if (!pulling) return super.dispatchTouchEvent(ev)
        when (ev.actionMasked) {
            MotionEvent.ACTION_MOVE -> pull.move((ev.rawY - downY).coerceAtLeast(0f))
            MotionEvent.ACTION_UP -> {
                val v = velocity
                v?.computeCurrentVelocity(1000)
                pulling = false
                pull.end(v?.yVelocity ?: 0f)
            }
            MotionEvent.ACTION_CANCEL -> {
                pulling = false
                pull.cancel()
            }
        }
        return true
    }
}
