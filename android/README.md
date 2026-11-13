# Linkpearl (Android)

The phone app for Aethernet: store numbers, alerts and work order lookup. Kotlin, Jetpack Compose, Material 3, single `app` module.
Scaffold state (Nov 13, 2026): Home is real UI on fake data; Alerts, Work orders, Settings and Onboarding are stubs.

## Build, test, screenshots

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools   # also ANDROID_SDK_ROOT; android/local.properties (untracked) has sdk.dir

cd ~/Scripts/ubif-aethernet-dev/android
./gradlew assembleDebug      # app/build/outputs/apk/debug/app-debug.apk
./gradlew test               # unit tests + the screenshot tests as plain tests (no PNGs written)
./gradlew screenshots        # same tests, writes PNGs to android/screenshots/<feature>/<device>-<name>-<dark|light>.png
./gradlew verifyRoborazziDebug   # compare fresh renders with the committed PNGs (fails on a pixel change)
```

Everything runs on the JVM (Robolectric native graphics + Roborazzi); no device or emulator. Robolectric runs at SDK 35 because SDK 36+
needs JDK 21 and this Mac has JDK 17 (`app/src/test/resources/robolectric.properties`); the app itself compiles against API 37.

Release (R8 on, keep rules in `app/proguard-rules.pro`): signing is read from `~/.gradle/gradle.properties` or environment variables,
four names: `LINKPEARL_KEYSTORE_FILE`, `LINKPEARL_KEYSTORE_PASSWORD`, `LINKPEARL_KEY_ALIAS`, `LINKPEARL_KEY_PASSWORD`.
`./gradlew assembleRelease` (or `bundleRelease`) without them stops at configuration with a message naming the missing ones. No keystore or
secret is in the project (`*.jks`, `*.keystore` are ignored). `./gradlew :app:minifyReleaseWithR8` runs R8 without needing signing.

## Versions (all confirmed Nov 13, 2026; stable releases only)

| Component | Version | Confirmed at |
|---|---|---|
| Android Gradle Plugin | 9.5.1 | Google Maven `com/android/tools/build/gradle/maven-metadata.xml` (latest stable; 9.6 is alpha); AGP 9.5 release notes (developer.android.com/build/releases/agp-9-5-0-release-notes): Gradle 9.6+, JDK 17, build tools 36.0.0, max API 37 |
| Gradle | 9.9.1 | `services.gradle.org/versions/current` (wrapper pinned with its SHA-256); AGP 9.5 needs 9.6 or newer |
| Kotlin (+ Compose compiler plugin, serialization plugin) | 2.4.21 | Maven Central `kotlin-gradle-plugin` (2.5.0 is beta); AGP 9 has built-in Kotlin, so no `kotlin-android` plugin |
| compileSdk / targetSdk / minSdk | 37 / 37 / 31 | AGP 9.5 notes (max API 37); SDK repository lists `platforms;android-37.0`; minSdk 31 for hardware-backed Keystore ECDH |
| Compose BOM | 2026.09.00 (ui/foundation 1.12.1, material3 1.4.0, navigation-suite 1.4.0) | Google Maven `compose-bom` and its POM |
| material3-adaptive (adaptive, layout, navigation) | 1.3.0 | Google Maven (stable; 1.4.0 is alpha) |
| androidx.window | 1.5.1 | Google Maven |
| Activity Compose / Lifecycle / Navigation Compose | 1.13.0 / 2.11.0 / 2.10.2 | Google Maven |
| core-ktx / core-splashscreen | 1.19.1 / 1.2.0 | Google Maven |
| DataStore (preferences) | 1.3.0 | Google Maven |
| WorkManager | 2.12.0 | Google Maven |
| Biometric | 1.1.0 | Google Maven (1.4.0 is beta) |
| security-crypto | 1.1.0 | Google Maven |
| kotlinx-serialization-json / coroutines | 1.13.0 / 1.11.0 | Maven Central |
| OkHttp (HTTP client) | 5.5.1 | Maven Central |
| Roborazzi (JVM screenshots) | 1.79.0 | Maven Central + project release notes (no AGP/Kotlin matrix published; verified working with the above) |
| Robolectric / JUnit | 4.18 / 4.13.2 | Maven Central; Robolectric needs JDK 21 for SDK 36+, hence SDK 35 in tests |

Paparazzi was not used (2.0 is alpha). The material3-adaptive-navigation-suite 1.4 API differs from older docs: `NavigationSuiteScaffold(navigationItems = {...})`
with `NavigationSuiteItem(...)` and a `navigationSuiteType` parameter.

## Layout

```
app/src/main/kotlin/dev/aethernet/linkpearl/
  LinkpearlApp.kt, MainActivity.kt      application (builds the container), edge-to-edge activity
  core/design   theme, colours (dark + light), typography (tabular numerals), spacing, shapes, icons, Components.kt, Charts.kt, Format.kt
  core/nav      Routes/TopLevel, AdaptiveState + HingeTwoPane, LpNavScaffold (bar/rail), LpListDetail, NavBadges, AppNavHost
  core/data     models (Home shape), HomeRepository + FakeHomeRepository, ApiClient/Auth/DeviceIdentity stubs, DataModule
  core/lock     AppLock interface, 30-minute constant, StubAppLock, LockModule
  core/di       AppContainer (service locator), FeatureModule, Modules.kt (the one list of modules)
  feature/home        real UI on fake data (HomeScreen, HomeCards, HomeViewModel, StorePreference on DataStore)
  feature/workorders  stub + WorkOrdersNav.kt + WorkOrdersModule.kt
  feature/alerts      stub + AlertsNav.kt + AlertsModule.kt
  feature/settings    stub + SettingsNav.kt + SettingsModule.kt
  feature/onboarding  stub (device registration lives here) + OnboardingModule.kt
app/src/test/kotlin/dev/aethernet/linkpearl/
  testing/Screenshots.kt        shared harness (Device sizes, simulated fold, shoot())
  core/..., feature/<x>/        unit tests next to the package they test
  feature/<x>/screenshot/       each feature's own screenshot tests (output: screenshots/<x>/)
```

## Fold, hinge, posture

`AdaptiveProvider` (core/nav) turns material3-adaptive's `WindowAdaptiveInfo` (which reads Jetpack WindowManager's `FoldingFeature`) into
`AdaptiveState`: compact (< 600dp: bottom bar, one column) or two-pane with rail; the first vertical fold's bounds (any state, so a flat
unfolded Z Fold counts); and `isTabletop` / `tabletopFold` for half-opened with a horizontal fold (exposed for later; Home has no tabletop layout).
`HingeTwoPane` puts the pane boundary on the fold (first pane ends at the fold's left edge, second starts at its right edge, at least a 32dp gutter,
the fold's own width when larger; it measures its offset in the window so the rail does not skew it). `LpListDetail` uses
`calculatePaneScaffoldDirective(info, HingePolicy.AlwaysAvoid)` for the same effect in list-detail screens. No device numbers anywhere.

## Package ownership

Only the owner of a package edits it. Shared files (`core/design`, `core/nav`, the manifest, any `*.gradle.kts`, `gradle/libs.versions.toml`,
`proguard-rules.pro`, `core/di`, `testing/`) are not edited by feature agents: request the change in your report. Everything a feature
predictably needs is already declared (permissions INTERNET, ACCESS_NETWORK_STATE, POST_NOTIFICATIONS, USE_BIOMETRIC, RECEIVE_BOOT_COMPLETED; WorkManager,
Biometric, DataStore, security-crypto, OkHttp, kotlinx-serialization, coroutines; deep-link scheme `linkpearl://`). Dial and text use intents (`ACTION_DIAL`,
`ACTION_SENDTO`), so no CALL/SMS permissions.

| Agent | Owns | Extension points |
|---|---|---|
| A | `feature/onboarding`, `feature/home` wiring, `core/data` (ApiClient, Auth, DeviceIdentity implementations, real HomeRepository) | `DataModule` and `OnboardingModule` (`c.provide<...> { ... }`); `Auth.state` decides onboarding vs the app; `HomeModule` |
| B | `feature/workorders`, `core/lock` | `WorkOrdersModule`, `LockModule` (provide the real `AppLock`); `workOrdersGraph()` for routes `workorders`, `workorders/{id}`; `LpListDetail` for list-detail |
| C | `feature/alerts`, background work and notifications | `AlertsModule`: `c.workerFactory.addFactory(...)`, `c.channel(ChannelSpec(...))`, `c.provide<NavBadges> { ... }`; `alertsGraph()` for `alerts`, `alerts/settings`; notifications open `linkpearl://...` |
| D | `feature/settings` | `SettingsModule`, `settingsGraph()` |

Scaffold-owned (changes by request): `feature/home` UI (finished; agent A only wires data), `core/design`, `core/nav`, `core/di`, manifest, Gradle, `testing/`.

Rules for everyone: no unnecessary text on screens; colour is never the only signal; "RFP total" for the dollar figure and "Ready for pickup" for counts;
null data is a dash, never 0; 48dp touch targets; TalkBack labels on icon buttons (`LpIconButton` requires one); every chart has a content description;
check font scale 1.3 (`shoot(fontScale = 1.3f)`).

## Writing a screenshot test (per feature)

```kotlin
@RunWith(RobolectricTestRunner::class)
class AlertsScreenshotTest {
    @get:Rule val rule = createComposeRule()
    @Test fun phoneDark() = rule.shoot("alerts", "list", Device.Phone, dark = true) { AlertsScreen() }
}
```
`Device` = Phone 412x915, PhoneTall, Cover 412x960, Inner 859x954 (flat vertical fold in the middle), InnerNoFold. Use `ParameterizedRobolectricTestRunner`
for device/theme matrices (see `HomeScreenshotTest`). Unit tests go beside the package under `app/src/test/kotlin/.../feature/<x>/`.

## Not verified without the owner's phone

Real fold bounds and state reporting on a Galaxy Z Fold, window insets and the system bars, the system splash and themed icon, predictive back,
TalkBack, the real font-scale setting, install and launch (no emulator or device was available), notification permission flow.
