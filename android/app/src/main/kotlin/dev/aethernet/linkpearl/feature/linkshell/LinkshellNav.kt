package dev.aethernet.linkpearl.feature.linkshell

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import android.app.Application
import android.os.Bundle
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import androidx.navigation.navDeepLink
import dev.aethernet.linkpearl.BuildConfig
import dev.aethernet.linkpearl.core.data.ApiClient
import dev.aethernet.linkpearl.core.data.Auth
import dev.aethernet.linkpearl.core.data.AuthState
import dev.aethernet.linkpearl.core.data.EncryptedFile
import dev.aethernet.linkpearl.core.data.OkHttpApiClient
import dev.aethernet.linkpearl.core.data.SessionStore
import dev.aethernet.linkpearl.core.data.keystoreBox
import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.FeatureModule
import dev.aethernet.linkpearl.core.di.LocalAppContainer
import dev.aethernet.linkpearl.core.nav.Routes
import dev.aethernet.linkpearl.feature.pullbacks.PullbackCamera
import dev.aethernet.linkpearl.feature.pullbacks.PullbackLink
import dev.aethernet.linkpearl.feature.buybacks.BuybackLink
import dev.aethernet.linkpearl.feature.pullbacks.QR_FORMATS
import java.io.File
import java.util.concurrent.TimeUnit

/** The link (`files/lp-linkshell.bin`), its connection, and the phone routes. The connection wakes whenever the app comes to the front. */
object LinkshellModule : FeatureModule {
    override fun install(c: AppContainer) {
        val app = c.application
        c.provide<LinkshellStore> { FileLinkshellStore(EncryptedFile(File(app.filesDir, "lp-linkshell.bin"), keystoreBox("linkpearl-data-v1"))) }
        c.provide<LinkshellClient> {
            val session = c.get<SessionStore>()
            val http = OkHttpApiClient.defaultHttpClient().newBuilder().readTimeout(0, TimeUnit.SECONDS).callTimeout(0, TimeUnit.SECONDS).build()
            LinkshellClient(c.get<LinkshellStore>(), OkHttpSockets(http), BuildConfig.API_BASE_URL, { session.current.credentials }, c.appScope)
        }
        c.provide<LinkshellRepository> { LinkshellRepository(c.get<ApiClient>()) }
        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityStarted(activity: Activity) { runCatching { c.get<PullbackLink>(); c.get<BuybackLink>(); c.get<LinkshellClient>().wake() } }
            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
            override fun onActivityResumed(activity: Activity) {}
            override fun onActivityPaused(activity: Activity) {}
            override fun onActivityStopped(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
    }
}

/** `linkshell` (also `linkpearl://linkshell`), opened from Settings. */
fun NavGraphBuilder.linkshellGraph(navigate: (String) -> Unit) {
    composable(Routes.LINKSHELL, deepLinks = listOf(navDeepLink { uriPattern = Routes.deepLink(Routes.LINKSHELL) })) { LinkshellRoute(navigate) }
}

@Composable
fun LinkshellRoute(navigate: (String) -> Unit) {
    val c = LocalAppContainer.current
    val back = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
    val vm: LinkshellViewModel = viewModel(factory = viewModelFactory {
        initializer { LinkshellViewModel(c.get<LinkshellClient>(), c.get<LinkshellRepository>(), runCatching { c.get<PullbackLink>() }.getOrNull(), runCatching { c.get<BuybackLink>() }.getOrNull()) }
    })
    val ui by vm.state.collectAsStateWithLifecycle()
    // Linked: ask once for notifications, so a request from the PC can reach this phone with the app closed (feature/push).
    val context = LocalContext.current
    val askNotify = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    val linked = ui is LsUi.Linked
    LaunchedEffect(linked) {
        if (linked && Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
    val stores = (runCatching { c.get<Auth>() }.getOrNull()?.state?.value as? AuthState.Registered)?.stores.orEmpty()
    LinkshellScreen(
        ui,
        LinkshellActions(
            onBack = { back?.onBackPressed() }, onCode = vm::onCode, onCancel = vm::cancel, onUnlink = vm::unlink,
            onJoin = { vm.join()?.let(navigate) },
        ),
        storeName = { id -> stores.firstOrNull { it.id == id }?.name?.takeIf { it.isNotBlank() } },
        camera = { onCode -> PullbackCamera("", onCode, QR_FORMATS) },
    )
}
