package dev.aethernet.linkpearl.feature.widget

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import dev.aethernet.linkpearl.LinkpearlApp
import dev.aethernet.linkpearl.core.data.Auth
import dev.aethernet.linkpearl.core.data.AuthState
import dev.aethernet.linkpearl.core.data.StoreRef
import dev.aethernet.linkpearl.core.data.StoreScope
import dev.aethernet.linkpearl.core.design.LinkpearlTheme
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpCard
import dev.aethernet.linkpearl.core.design.LpIcon
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpListRow
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.prefs.AppPrefs
import dev.aethernet.linkpearl.feature.home.StorePreference
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * Which store a widget shows: All stores or one approved store. Opened by the launcher when a widget is reconfigured (placing one
 * skips it: the widget then shows Home's current store). The current choice is preselected.
 */
class WidgetConfigActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val id = intent?.extras?.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID) ?: AppWidgetManager.INVALID_APPWIDGET_ID
        if (id == AppWidgetManager.INVALID_APPWIDGET_ID) { finish(); return }
        setResult(RESULT_CANCELED, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id))

        val container = (application as LinkpearlApp).container
        val stores = (container.get<Auth>().state.value as? AuthState.Registered)?.stores.orEmpty()
        val config = container.get<WidgetConfig>()
        val homePref = container.get<StorePreference>()
        val appearance = container.get<AppPrefs>().appearanceNow()
        enableEdgeToEdge()
        setContent {
            val current by produceState<String?>(null) { value = config.scopeKey(id).first() ?: homePref.scope.first().key }
            LinkpearlTheme(darkTheme = appearance.isDark(isSystemInDarkTheme())) {
                WidgetStorePicker(stores, current) { scope ->
                    lifecycleScope.launch {
                        config.set(id, scope)
                        container.appScope.launch { runCatching { container.get<WidgetRefresher>().refreshAll(force = true) } }
                        setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id))
                        finish()
                    }
                }
            }
        }
    }
}

@Composable
fun WidgetStorePicker(stores: List<StoreRef>, selected: String?, onPick: (StoreScope) -> Unit) {
    val c = Lp.colors
    Column(
        Modifier.fillMaxSize().background(c.page).safeDrawingPadding().verticalScroll(rememberScrollState()).padding(horizontal = LpSpacing.Gutter, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(LpSpacing.L),
    ) {
        Text("Store", style = LpType.Screen, color = c.fg, modifier = Modifier.heightIn(min = LpSpacing.Touch).semantics { heading() })
        LpCard(padding = 0.dp) {
            val options = listOf<Pair<StoreScope, String>>(StoreScope.All to WidgetSnapshot.ALL_STORES) + stores.map { StoreScope.One(it.id) to it.label }
            options.forEachIndexed { i, (scope, label) ->
                if (i > 0) HorizontalDivider(color = c.line)
                val on = scope.key == selected
                LpListRow(
                    label, selected = on, onClick = { onPick(scope) },
                    leading = { LpIcon(LpIcons.Store, null, tint = if (on) c.onAccSoft else c.soft) },
                    trailing = { if (on) LpIcon(LpIcons.Check, null, tint = c.onAccSoft) },
                )
            }
        }
    }
}
