package dev.aethernet.linkpearl.feature.pullbacks

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import androidx.navigation.navDeepLink
import dev.aethernet.linkpearl.core.data.Auth
import dev.aethernet.linkpearl.core.data.AuthState
import dev.aethernet.linkpearl.core.di.AppContainer
import dev.aethernet.linkpearl.core.di.FeatureModule
import dev.aethernet.linkpearl.core.di.LocalAppContainer
import dev.aethernet.linkpearl.core.nav.Routes
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/** Where Pullbacks keeps its run (`files/pullbacks/`). */
object PullbacksModule : FeatureModule {
    override fun install(c: AppContainer) {
        c.provide<PbStore> { FilePbStore(File(c.application.filesDir, "pullbacks")) }
    }
}

/** `pullbacks` (also `linkpearl://pullbacks`), opened from Retrace's header. */
fun NavGraphBuilder.pullbacksGraph() {
    composable(Routes.PULLBACKS, deepLinks = listOf(navDeepLink { uriPattern = Routes.deepLink(Routes.PULLBACKS) })) { PullbacksRoute() }
}

private const val XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

@Composable
fun PullbacksRoute() {
    val c = LocalAppContainer.current
    val context = LocalContext.current
    val back = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
    val scope = rememberCoroutineScope()
    val vm: PullbackViewModel = viewModel(factory = viewModelFactory {
        initializer {
            val stores = (runCatching { c.get<Auth>() }.getOrNull()?.state?.value as? AuthState.Registered)?.stores?.map { it.id }.orEmpty()
            PullbackViewModel(c.get<PbStore>(), stores)
        }
    })
    val ui by vm.state.collectAsStateWithLifecycle()
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) scope.launch {
            val read = withContext(Dispatchers.IO) { runCatching { displayName(context, uri) to context.contentResolver.openInputStream(uri)!!.use { it.readBytes() } } }
            read.onSuccess { (name, bytes) -> vm.open(name, bytes) }
        }
    }
    PullbackScreen(
        ui,
        PullbackActions(
            onBack = { back?.onBackPressed() },
            onOpenFile = { pick.launch(arrayOf(XLSX, "text/csv", "text/comma-separated-values", "application/vnd.ms-excel", "application/octet-stream")) },
            onResume = vm::resume, onDiscard = vm::discard, onPickStore = vm::pickStore, onChangeFile = { vm.changeFile() }, onStart = vm::start,
            onScan = vm::scan, onAccept = vm::acceptAnyway, onSkip = vm::skip, onUndo = vm::undo, onScanSkipped = vm::scanSkipped, onNewFile = { vm.newFile() },
            onShare = { vm.results()?.let { (name, bytes) -> scope.launch { share(context, name, bytes) } } },
        ),
        camera = { expected, onCode -> PullbackCamera(expected, onCode) },
    )
}

private fun displayName(context: Context, uri: Uri): String =
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cur ->
        if (cur.moveToFirst()) cur.getString(0) else null
    } ?: uri.lastPathSegment?.substringAfterLast('/') ?: "Pullback Serials.xlsx"

/** The results file through the share sheet (cache/pullbacks/<name>, served by this app's FileProvider). */
private suspend fun share(context: Context, name: String, bytes: ByteArray) {
    val file = withContext(Dispatchers.IO) {
        File(context.cacheDir, "pullbacks").apply { mkdirs(); listFiles()?.forEach { it.delete() } }.let { File(it, name).apply { writeBytes(bytes) } }
    }
    val uri = FileProvider.getUriForFile(context, context.packageName + ".files", file)
    val send = Intent(Intent.ACTION_SEND).setType(XLSX).putExtra(Intent.EXTRA_STREAM, uri).putExtra(Intent.EXTRA_SUBJECT, name)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    context.startActivity(Intent.createChooser(send, name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}
