package nz.joshp.sink.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import nz.joshp.sink.R

/**
 * Roboto Flex, as on the web. One variable font file (Latin, weight and optical size axes only, see
 * android/OFL-RobotoFlex.txt); Compose sets its weight axis to match each weight asked for.
 */
val RobotoFlex = FontFamily((100..900 step 100).map { Font(R.font.roboto_flex, FontWeight(it)) })

private fun TextStyle.flex() = copy(fontFamily = RobotoFlex)

internal val SinkTypography = Typography().run {
    copy(
        displayLarge = displayLarge.flex(),
        displayMedium = displayMedium.flex(),
        displaySmall = displaySmall.flex(),
        headlineLarge = headlineLarge.flex(),
        headlineMedium = headlineMedium.flex(),
        headlineSmall = headlineSmall.flex(),
        titleLarge = titleLarge.flex(),
        titleMedium = titleMedium.flex(),
        titleSmall = titleSmall.flex(),
        bodyLarge = bodyLarge.flex(),
        bodyMedium = bodyMedium.flex(),
        bodySmall = bodySmall.flex(),
        labelLarge = labelLarge.flex(),
        labelMedium = labelMedium.flex(),
        labelSmall = labelSmall.flex(),
    )
}
