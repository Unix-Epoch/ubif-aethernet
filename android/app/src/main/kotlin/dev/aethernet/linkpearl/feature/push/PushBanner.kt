package dev.aethernet.linkpearl.feature.push

import android.content.Intent
import android.net.Uri
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpIcon
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.di.LocalAppContainer
import dev.aethernet.linkpearl.core.nav.Routes
import kotlinx.coroutines.delay

/** Shows each Linkshell ping as a banner at the top while the app is open (MainActivity draws it over every screen). */
@Composable
fun PushBannerHost() {
    val container = LocalAppContainer.current
    val center = remember(container) { runCatching { container.get<PushCenter>() }.getOrNull() } ?: return
    val context = LocalContext.current
    var note by remember { mutableStateOf<PushNote?>(null) }
    var visible by remember { mutableStateOf(false) }
    LaunchedEffect(center) { center.banners.collect { note = it; visible = true } }
    LaunchedEffect(note, visible) { if (visible) { delay(SHOW_MS); visible = false } }
    Box(Modifier.fillMaxWidth().statusBarsPadding().padding(top = LpSpacing.S), contentAlignment = Alignment.TopCenter) {
        AnimatedVisibility(visible, enter = slideInVertically { -it } + fadeIn(), exit = slideOutVertically { -it } + fadeOut()) {
            note?.let { n ->
                PushBanner(n, onClick = {
                    visible = false
                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(Routes.deepLink(n.route))).setPackage(context.packageName))
                })
            }
        }
    }
}

@Composable
fun PushBanner(note: PushNote, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = Lp.colors
    Row(
        modifier.padding(horizontal = LpSpacing.Gutter).widthIn(max = 480.dp).fillMaxWidth()
            .shadow(12.dp, LpShapes.Notice, ambientColor = c.shadow, spotColor = c.shadow).clip(LpShapes.Notice).background(c.surf2).border(1.dp, c.line, LpShapes.Notice)
            .clickable(role = Role.Button, onClick = onClick).padding(horizontal = LpSpacing.L, vertical = LpSpacing.M),
        horizontalArrangement = Arrangement.spacedBy(LpSpacing.M), verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(36.dp).background(c.accSoft, CircleShape), contentAlignment = Alignment.Center) {
            LpIcon(LpIcons.Link, null, size = 20.dp, tint = c.onAccSoft)
        }
        Column(Modifier.weight(1f)) {
            Text(note.title, style = LpType.BodyStrong, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (note.text.isNotBlank()) Text(note.text, style = LpType.Small, color = c.soft, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

private const val SHOW_MS = 2_500L
