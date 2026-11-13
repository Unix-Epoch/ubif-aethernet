import org.gradle.api.GradleException

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.roborazzi)
}

// ---- Release signing: read from ~/.gradle/gradle.properties (or -P flags) or from environment variables.
// Property / variable names (the same four, either place):
//   LINKPEARL_KEYSTORE_FILE, LINKPEARL_KEYSTORE_PASSWORD, LINKPEARL_KEY_ALIAS, LINKPEARL_KEY_PASSWORD
// Nothing is stored in the project. Building a release artifact without them fails at configuration time with a clear message.
fun signingValue(name: String): String? =
    (providers.gradleProperty(name).orNull ?: providers.environmentVariable(name).orNull)?.takeIf { it.isNotBlank() }

val signingNames = listOf("LINKPEARL_KEYSTORE_FILE", "LINKPEARL_KEYSTORE_PASSWORD", "LINKPEARL_KEY_ALIAS", "LINKPEARL_KEY_PASSWORD")
val missingSigning = signingNames.filter { signingValue(it) == null }
val wantsReleaseArtifact = gradle.startParameter.taskNames.any {
    Regex("(assemble|bundle|package|install)Release", RegexOption.IGNORE_CASE).containsMatchIn(it)
}
if (wantsReleaseArtifact && missingSigning.isNotEmpty()) {
    throw GradleException(
        "Release signing is not configured. Missing: ${missingSigning.joinToString()}. " +
            "Set them in ~/.gradle/gradle.properties or as environment variables (see android/README.md). " +
            "No keystore is kept in the project."
    )
}

android {
    namespace = "dev.aethernet.linkpearl"
    compileSdk { version = release(37) }

    defaultConfig {
        applicationId = "dev.aethernet.linkpearl"
        minSdk = 31 // hardware-backed ECDH in the Android Keystore needs API 31
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0"

        // Server base URL and the public app key (one place: android/gradle.properties).
        fun prop(name: String) = providers.gradleProperty(name).get().replace("\\", "\\\\").replace("\"", "\\\"")
        buildConfigField("String", "API_BASE_URL", "\"${prop("linkpearl.baseUrl")}\"")
        buildConfigField("String", "APP_KEY", "\"${prop("linkpearl.appKey")}\"")
    }

    buildFeatures { buildConfig = true }

    signingConfigs {
        if (missingSigning.isEmpty()) {
            create("release") {
                storeFile = file(signingValue("LINKPEARL_KEYSTORE_FILE")!!)
                storePassword = signingValue("LINKPEARL_KEYSTORE_PASSWORD")
                keyAlias = signingValue("LINKPEARL_KEY_ALIAS")
                keyPassword = signingValue("LINKPEARL_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (missingSigning.isEmpty()) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/versions/**")
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true // Robolectric needs merged resources for the JVM screenshot tests
            all {
                it.systemProperty("linkpearl.screenshotDir", rootProject.layout.projectDirectory.dir("screenshots").asFile.absolutePath)
                it.maxHeapSize = "2g"
            }
        }
    }
}

kotlin {
    jvmToolchain(17)
    compilerOptions {
        freeCompilerArgs.addAll(
            "-opt-in=androidx.compose.material3.ExperimentalMaterial3Api",
            "-opt-in=androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi",
            "-opt-in=androidx.compose.material3.adaptive.navigationsuite.ExperimentalMaterial3AdaptiveNavigationSuiteApi",
        )
    }
}

roborazzi {
    // Screenshots are written by the tests themselves to android/screenshots (see testing/Screenshots.kt).
    outputDir.set(rootProject.layout.projectDirectory.dir("screenshots"))
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.navigation.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material3.adaptive.navigation.suite)
    implementation(libs.androidx.adaptive)
    implementation(libs.androidx.adaptive.layout)
    implementation(libs.androidx.adaptive.navigation)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.window)

    // Declared now so no feature agent has to touch this file:
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.biometric)
    implementation(libs.androidx.security.crypto)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.androidx.compose.ui.test.junit4)
    testImplementation(libs.androidx.window.testing)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
}

// `./gradlew screenshots` renders every screenshot test and writes the PNGs to android/screenshots/ (JVM only, no device).
tasks.register("screenshots") { dependsOn("recordRoborazziDebug") }
