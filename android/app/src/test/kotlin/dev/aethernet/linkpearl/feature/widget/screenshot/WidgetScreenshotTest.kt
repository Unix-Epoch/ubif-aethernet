package dev.aethernet.linkpearl.feature.widget.screenshot

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.ExperimentalGlanceApi
import androidx.glance.GlanceId
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.compose
import androidx.glance.appwidget.provideContent
import com.github.takahirom.roborazzi.captureRoboImage
import dev.aethernet.linkpearl.feature.widget.LinkpearlWidgetContent
import dev.aethernet.linkpearl.feature.widget.SalesWidgetContent
import dev.aethernet.linkpearl.feature.widget.WidgetSnapshot
import dev.aethernet.linkpearl.feature.widget.WidgetUi
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.ParameterizedRobolectricTestRunner.Parameters
import org.robolectric.Robolectric
import org.robolectric.RuntimeEnvironment
import java.io.File
import java.time.Instant

/**
 * The widgets as the launcher draws them: Glance composes the real RemoteViews ([compose]), Robolectric inflates them, Roborazzi
 * captures. Fake data (the mock-up's numbers). Sizes: the home-screen card, the Fold's cover screen (grid), the narrowest grid, and the
 * small widget at its two sizes. Written to `screenshots/widget/`.
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
class WidgetScreenshotTest(private val dark: Boolean) {
    companion object {
        @JvmStatic @Parameters(name = "dark={0}")
        fun params() = listOf(arrayOf<Any>(true), arrayOf<Any>(false))

        private const val DENSITY = 2f

        val sample = WidgetSnapshot(
            scope = "999999", store = "Sandbox #999999", asOf = "2026-11-15T21:12:00Z", tz = "America/New_York",
            salesToday = 2418.0, salesYesterday = 2096.0, week = listOf(1500.0, 120.0, 1600.0, 1350.0, 1820.0, 1680.0, 2418.0),
            splh = 172.0, target = listOf(160, 180), rfpTotal = 885.0, rfpCount = 3, rfpOldestDays = 12,
            lanes = listOf(2, 3, 7, 5, 3), open = 20,
        )
        private val at = Instant.parse("2026-11-15T21:20:00Z").toEpochMilli()
    }

    private class Preview(private val ui: WidgetUi, private val sales: Boolean) : GlanceAppWidget() {
        override val sizeMode = SizeMode.Exact
        override suspend fun provideGlance(context: Context, id: GlanceId) = provideContent {
            if (sales) SalesWidgetContent(ui) else LinkpearlWidgetContent(ui)
        }
    }

    private val outDir = File(System.getProperty("linkpearl.screenshotDir") ?: "build/screenshots", "widget")

    @OptIn(ExperimentalGlanceApi::class)
    private fun shoot(name: String, w: Int, h: Int, sales: Boolean = false, ui: WidgetUi = WidgetUi.from(sample, at)) {
        // The frame sits below a gap at the top so the window's emulated status bar is not in the captured area.
        val top = 80
        RuntimeEnvironment.setQualifiers("w${w + 48}dp-h${h + 48 + top}dp-" + (if (dark) "night" else "notnight") + "-xhdpi")
        val controller = Robolectric.buildActivity(Activity::class.java).create()
        val activity = controller.get()
        activity.requestWindowFeature(android.view.Window.FEATURE_NO_TITLE)
        val views = runBlocking { Preview(ui, sales).compose(activity, size = DpSize(w.dp, h.dp)) }
        val px = { dp: Int -> (dp * DENSITY).toInt() }
        val frame = FrameLayout(activity).apply {
            setBackgroundColor(if (dark) Color.rgb(0x4A, 0x2D, 0x63) else Color.rgb(0xE4, 0xDC, 0xEE))
            setPadding(px(24), px(24), px(24), px(24))
        }
        frame.addView(views.apply(activity, frame), FrameLayout.LayoutParams(px(w), px(h)))
        val outer = FrameLayout(activity).apply { setPadding(0, px(top), 0, 0) }
        outer.addView(frame, FrameLayout.LayoutParams(px(w + 48), px(h + 48)))
        activity.setContentView(outer, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        controller.start().resume().visible()
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
        outDir.mkdirs()
        frame.captureRoboImage(File(outDir, "$name-${if (dark) "dark" else "light"}.png").path)
    }

    @Test fun linkpearlHomeScreen() = shoot("linkpearl-home", 380, 230)
    @Test fun linkpearlCoverScreen() = shoot("linkpearl-cover", 380, 170)
    @Test fun linkpearlNarrow() = shoot("linkpearl-narrow", 180, 110)
    @Test fun linkpearlEmpty() = shoot("linkpearl-empty", 380, 230, ui = WidgetUi.Empty)
    @Test fun linkpearlUnderTarget() = shoot("linkpearl-under", 380, 230, ui = WidgetUi.from(sample.copy(splh = 141.0, store = "All stores"), at))
    @Test fun salesWidget() = shoot("sales", 180, 170, sales = true)
    @Test fun salesWidgetSmall() = shoot("sales-small", 110, 80, sales = true)
}
