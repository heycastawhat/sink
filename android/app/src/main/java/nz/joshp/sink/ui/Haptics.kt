package nz.joshp.sink.ui

import android.os.Build
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalView

/**
 * The few haptic beats the app uses, so a screen asks for what happened ("confirm") and not which system constant
 * fits. Newer constants are used where the OS has them and a plain click stands in before that (minSdk is 30, so
 * only API 34's need a check). Like all view haptics they follow the system's touch feedback setting.
 */
class Haptics internal constructor(private val view: View) {
    private fun buzz(constant: Int) {
        view.performHapticFeedback(constant)
    }

    /** A light step: moving between tabs, opening a menu, picking an option. */
    fun tick() = buzz(if (Build.VERSION.SDK_INT >= 34) HapticFeedbackConstants.SEGMENT_TICK else HapticFeedbackConstants.CLOCK_TICK)

    /** Something got done: a todo ticked, a note pinned, an item saved. */
    fun confirm() = buzz(HapticFeedbackConstants.CONFIRM)

    /** Something was refused or is destructive: delete, cancel todo, an error. */
    fun reject() = buzz(HapticFeedbackConstants.REJECT)

    /** A switch or check flipping. */
    fun toggle(on: Boolean) = buzz(
        if (Build.VERSION.SDK_INT >= 34) {
            if (on) HapticFeedbackConstants.TOGGLE_ON else HapticFeedbackConstants.TOGGLE_OFF
        } else {
            HapticFeedbackConstants.CONTEXT_CLICK
        },
    )

    /** A press held long enough to mean something (card selection, drag start). */
    fun longPress() = buzz(HapticFeedbackConstants.LONG_PRESS)

    /** A drag crossing the point where letting go will act (swipe to tomorrow, pull up to create). */
    fun threshold() = buzz(if (Build.VERSION.SDK_INT >= 34) HapticFeedbackConstants.GESTURE_THRESHOLD_ACTIVATE else HapticFeedbackConstants.CONTEXT_CLICK)
}

@Composable
fun rememberHaptics(): Haptics {
    val view = LocalView.current
    return remember(view) { Haptics(view) }
}
