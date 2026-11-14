package dev.aethernet.linkpearl.feature.workorders

import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import dev.aethernet.linkpearl.MainActivity
import dev.aethernet.linkpearl.core.nav.Routes

/**
 * Portal work order links (`https://portal.ubreakifix.net/repair/workorder/<number>`, the exact shape [WoFmt.portalUrl] builds) opened or
 * shared into the app. The number is mapped onto the existing `linkpearl://workorders/<number>` path: a bare number searches Work orders.
 */
object PortalLink {
    private val link = Regex(
        """(?<![\w/.\-])https://portal\.ubreakifix\.net/repair/workorder/(\d{1,18})/?(?:[?#]\S*?)?[.,;:!)\]>"']*(?=\s|$)""",
        RegexOption.IGNORE_CASE,
    )

    /** The work order number in the first Portal work order URL found in [text] (a plain URL or a shared message), else null. */
    fun numberIn(text: CharSequence?): String? = text?.let { link.find(it)?.groupValues?.get(1) }

    /** `linkpearl://workorders/<number>` for the Portal link in [text], else null. */
    fun deepLink(text: CharSequence?): String? = numberIn(text)?.let { Routes.deepLink(Routes.workOrder(it)) }

    /** The deep link for an intent's action, data and shared text; null when the intent carries no Portal work order link. */
    fun deepLinkFor(action: String?, data: String?, type: String?, text: CharSequence?): String? = when (action) {
        Intent.ACTION_VIEW -> data?.let { deepLink(it.trim()) }
        Intent.ACTION_SEND -> if (type == "text/plain") deepLink(text) else null
        else -> null
    }

    /**
     * A VIEW of a Portal link, or a text/plain SEND containing one, becomes a VIEW of the matching `linkpearl://` link so the one nav
     * deep-link path handles it. Any other intent (a share without a Portal link included) is returned unchanged.
     */
    fun normalize(intent: Intent): Intent {
        val to = deepLinkFor(intent.action, intent.dataString, intent.type, intent.getCharSequenceExtra(Intent.EXTRA_TEXT)) ?: return intent
        return Intent(intent).setAction(Intent.ACTION_VIEW).setDataAndType(Uri.parse(to), null).also { it.removeExtra(Intent.EXTRA_TEXT) }
    }

    /**
     * The work order a Portal-link search should open: only when it is finished, has no problem, is for [number] and found exactly one.
     */
    fun singleResult(number: String?, search: SearchUi?): WoKey? {
        if (number == null || search == null || search.busy || search.problem != null || search.needsUnlock) return null
        if (search.query.trim() != number) return null
        return search.results.singleOrNull()?.key
    }

    /** True for the id a Portal link produces: digits only (a `store-wo` id is a different, already handled form). */
    fun isBareNumber(id: String?): Boolean = id != null && id.isNotEmpty() && id.all { it.isDigit() }

    /** Which browser package opens the Portal: the default one if it is a real browser, else the first other browser; never [own]. */
    fun pickBrowser(default: String?, candidates: List<String>, own: String): String? =
        default?.takeIf { it != own && it != "android" && it in candidates }
            ?: candidates.firstOrNull { it != own && it != "android" }
}

/**
 * Opens the Portal page in a browser, never in Linkpearl itself (which claims these links once the owner enables it under "Open by default").
 * The default browser is found through an `http` probe (Linkpearl only claims `https` Portal links, so it never answers the probe);
 * without one, a chooser with Linkpearl excluded.
 */
fun Context.openPortal(wo: Long) {
    val view = Intent(Intent.ACTION_VIEW, Uri.parse(WoFmt.portalUrl(wo))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val probe = Intent(Intent.ACTION_VIEW, Uri.parse("http://")).addCategory(Intent.CATEGORY_BROWSABLE)
    val pm = packageManager
    val candidates = runCatching {
        pm.queryIntentActivities(probe, PackageManager.MATCH_ALL).map { it.activityInfo.packageName }.distinct()
    }.getOrDefault(emptyList())
    val default = runCatching { pm.resolveActivity(probe, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName }.getOrNull()
    val browser = PortalLink.pickBrowser(default, candidates, packageName)
    if (browser != null) {
        try { startActivity(Intent(view).setPackage(browser)); return } catch (_: ActivityNotFoundException) {}
    }
    val chooser = Intent.createChooser(view, null)
        .putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, arrayOf(ComponentName(this, MainActivity::class.java)))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try { startActivity(chooser) } catch (_: ActivityNotFoundException) {}
}
