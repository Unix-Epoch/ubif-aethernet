# Linkpearl (Android)

The phone app for Aethernet: store numbers, alerts and work order lookup. Kotlin, Jetpack Compose, Material 3, single `app` module.
Version 1.0.1 (versionCode 2), Nov 13, 2026: all five areas are built and merged: device sign-in (Onboarding), Home, Work orders (with
unlock of encrypted customer details), Alerts (feed, per-phone settings, background check, notifications) and Settings. The app talks to the
tracker Worker (`tracker-worker/MOBILE-API*.md`); there is no other server.

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

## Architecture

```
app/src/main/kotlin/dev/aethernet/linkpearl/
  LinkpearlApp.kt, MainActivity.kt   application (builds the container); singleTask edge-to-edge activity (new deep links arrive through onNewIntent)
  core/design   theme, colours (dark + light), typography, icons (every icon of every feature), Components.kt, Charts.kt, Format.kt
  core/nav      Routes/TopLevel, AdaptiveState + HingeTwoPane, LpNavScaffold (bar/rail), LpListDetail, NavBadges, AppNavHost (the one NavHost)
  core/data     ApiClient (OkHttp), RealAuth (register, approve, sign out), DeviceIdentity (Keystore P-256), SessionStore (encrypted), StoreZone,
                HomeRepository; the Fake* classes are for tests and screenshots
  core/lock     RealAppLock (system prompt, in-memory store keys, 30-minute idle and 60-second background re-lock), SealedBox crypto
  core/prefs    app preferences (appearance, notification-ask flag) on DataStore
  core/di       AppContainer (service locator), FeatureModule, Modules.kt (the one list of modules)
  feature/home, onboarding, workorders, alerts, settings   one package each; each registers its destinations through `*Graph()` and its services in its `*Module`
app/src/test/kotlin/dev/aethernet/linkpearl/
  testing/Screenshots.kt   shared harness (Device sizes, simulated vertical fold, tabletop posture, extra composition locals)
  core/..., feature/<x>/   unit tests next to the package; feature/<x>/screenshot/ the screenshot tests (output screenshots/<x>/)
  integration/             WholeAppIntegrationTest (opt-in, below)
tools/  local-server.mjs (the real Worker over HTTP on localhost), run-integration.sh, overview.py (contact sheet)
```

Navigation: one `NavHost` in `core/nav/AppNavHost.kt` with destinations `home`, `alerts`, `alerts/settings`, `workorders`, `workorders/{store}-{wo}` and
`settings`. Alerts and Settings open each other's screens through that same NavController, so Back from a work order opened from Alerts returns to
Alerts, and Back from Alert settings returns to Alerts or Settings, whichever opened it. Detail destinations hide the bottom bar on phones (the rail stays on wide
screens). Notifications and `linkpearl://` links use the same routes (`linkpearl://workorders/914-7000001`); a link arriving while the app runs goes to the
running activity (launch mode singleTask, `onNewIntent`) and lands on top of the current back stack.

Sign-in: Onboarding registers the phone (`POST /v1/agents/register`); the owner approves it on the admin site; the app polls `/v1/agents/me` and then holds
the store ids and the wrapped store keys. "Forget this phone" calls `POST /v1/agents/m/prefs/forget` first (best effort: offline or refused still
forgets locally), then wipes the token, state, device key, saved Home answers, alerts cursor and work, and locks. Every request carries `x-aethernet-key` and,
once registered, the Bearer token; the app also sends `x-linkpearl-version: 1.0.0+1` (name and code) so the server can read it later. The server's `MIN_APP`
(`tracker-worker/src/mobile-prefs.js`, answered by `GET /v1/agents/m/prefs`) is code 1 / name 1.0.0; raise it only together with a breaking server change. The
app does not show an update notice yet.

Times: Home reports the stores' time zone (`tz`); `StoreZone` keeps it with the session, and Work orders, Alerts and Settings format times in it (default
America/New_York until Home has answered once).

Lock: Settings' Lock/Unlock control, the Work orders header and the unlock overlay all drive the one `AppLock` (`RealAppLock`, platform BiometricPrompt with the
phone's screen lock as fallback), so they stay in step; forgetting the phone, a revoked registration or a change of approved stores locks it.

## Fold, hinge, posture

`AdaptiveProvider` (core/nav) turns material3-adaptive's `WindowAdaptiveInfo` (which reads Jetpack WindowManager's `FoldingFeature`) into
`AdaptiveState`: compact (< 600dp: bottom bar, one column) or two-pane with rail; the first vertical fold's bounds (any state, so a flat
unfolded Z Fold counts); and `isTabletop` / `tabletopFold` for half-opened with a horizontal fold (exposed for later; Home has no tabletop layout).
`HingeTwoPane` puts the pane boundary on the fold (first pane ends at the fold's left edge, second starts at its right edge, at least a 32dp gutter,
the fold's own width when larger; it measures its offset in the window so the rail does not skew it). `LpListDetail` uses
`calculatePaneScaffoldDirective(info, HingePolicy.AlwaysAvoid)` for the same effect in list-detail screens. No device numbers anywhere.

## Rules for screens

No unnecessary text on screens (labels, values, units only); colour is never the only signal; "RFP total" for the dollar figure and "Ready for pickup" for counts;
"Portal" is a proper noun; null data is a dash, never 0; 48dp touch targets; TalkBack labels on icon buttons (`LpIconButton` requires one); every chart has a
content description; check font scale 1.3 (`shoot(fontScale = 1.3f)`). Shared components live in `core/design`; do not draw a second version of a chip or button.

## Writing a screenshot test (per feature)

```kotlin
@RunWith(RobolectricTestRunner::class)
class AlertsScreenshotTest {
    @get:Rule val rule = createComposeRule()
    @Test fun phoneDark() = rule.shoot("alerts", "list", Device.Phone, dark = true) { AlertsScreen() }
}
```
Options: `fontScale`, `tabletop` (half-opened Fold held like a laptop, horizontal fold; adds `-tabletop` to the file name), `providers` (extra composition locals). `Device` = Phone 412x915, PhoneTall, Cover 412x960, Inner 859x954 (flat vertical fold in the middle), InnerNoFold. Use `ParameterizedRobolectricTestRunner`
for device/theme matrices (see `HomeScreenshotTest`). Unit tests go beside the package under `app/src/test/kotlin/.../feature/<x>/`.

## Local server and the integration test

`tools/local-server.mjs` runs the REAL tracker Worker code (`tracker-worker/src`) over HTTP on localhost with a seeded local database (a throwaway directory
under `tracker-worker/`; nothing remote is touched, wrangler only runs its local proxy). `tools/run-integration.sh` starts it, runs the two opt-in JVM tests
(`LocalServerIntegrationTest`, `WholeAppIntegrationTest`) against it and stops it:

```sh
cd tracker-worker && npm ci          # once
cd ../android && ./tools/run-integration.sh      # needs JAVA_HOME / ANDROID_HOME as above
```
Both tests are skipped (pass) unless `LINKPEARL_LOCAL_SERVER` is set, so `./gradlew test` stays offline. The whole-app test walks register, approve, Home, the
work order list, a sealed detail whose card and snapshot are opened through the real `RealAppLock` and `SealedBox` with keys unwrapped by a software device key,
the server's alerts tick (one alert of each type), the background check with a recording notifier, the feed and read marks, quiet hours and a threshold change,
the prefs route, forget, and the 401 afterwards. The server's clock is moved (control route `/__ctl/clock`) so every rule can fire.

## Build and release

Debug: `./gradlew assembleDebug` (`app/build/outputs/apk/debug/app-debug.apk`). Release: R8 on, signed from `LINKPEARL_KEYSTORE_FILE`, `LINKPEARL_KEYSTORE_PASSWORD`,
`LINKPEARL_KEY_ALIAS`, `LINKPEARL_KEY_PASSWORD` (environment or `~/.gradle/gradle.properties`); create the keystore yourself once (`keytool -genkeypair ...`), keep it and its
passwords outside the repo, and use the same one for every update, otherwise Android refuses to install an update over the old app. `./gradlew assembleRelease`
without those properties stops with a message naming the missing ones. The server URL and public app key are Gradle properties `linkpearl.baseUrl` and `linkpearl.appKey`
(defaults in `app/build.gradle.kts`). Before the app works for real, the server side must be deployed (migrations `2026-11-13-mobile-devices.sql`, `2026-11-13-mobile-alerts.sql`,
`2026-11-13-mobile-wo-index.sql`, then the tracker Worker; see `tracker-worker/MOBILE-API.md` "Deploy order").

## Alert timing

How soon a new alert reaches the phone is set by Android, not by the app. The app polls `GET /v1/agents/m/alerts/new` from a unique 15-minute `PeriodicWorkRequest`
(network required, exponential backoff on transient failures, one cursor so a late run still gets everything since the last one). Verified against the official
Android documentation (Nov 13, 2026; nothing for Android 17 was found):

- 15 minutes is the minimum period and a floor, not a promise: periodic work is inexact, and it does not run until its constraints are met
  ([define work](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work),
  [PeriodicWorkRequest](https://developer.android.com/reference/androidx/work/PeriodicWorkRequest)).
- Doze (screen off, unplugged, still) suspends network and defers jobs to maintenance windows that become less frequent; the docs give no spacing
  ([Doze and App Standby](https://developer.android.com/training/monitoring-device-state/doze-standby)).
- On battery, regular job time per standby bucket: Active 20 min per rolling hour (a limit new in Android 16; before it Active had none), Working set 10 min per 4 h, Frequent 10 min per
  12 h, Rare 10 min per 24 h with network disabled, Restricted once a day; the numbers are not guarantees and can change
  ([power details](https://developer.android.com/topic/performance/power/power-details), [App Standby Buckets](https://developer.android.com/topic/performance/appstandby)).
  Android 16 also tightens runtime quotas by bucket ([behavior changes](https://developer.android.com/about/versions/16/behavior-changes-all)). A 15-minute poll needs seconds, so quota is not the limit; the bucket and Doze are.
- Supportable improvements: use the app regularly (opening it or tapping its notification keeps it in Active or Working set; the docs say not to try to game the bucket); the owner
  setting Battery to Unrestricted (exempts it from Doze and Standby network limits and gives it generous job quota and no alarm limits; the in-app prompt `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
  is restricted by Google Play policy for this kind of app, the docs say nothing about sideloaded apps, and the app does not use it). The user setting Restricted stops jobs entirely and, on Android 13+,
  boot completion is not delivered until the app is opened ([background optimization](https://developer.android.com/topic/performance/background-optimization)).
- Not suitable: expedited work (one-time work only, short tasks, quota-limited), exact alarms and foreground services for recurring background work
  ([persistent work](https://developer.android.com/develop/background-work/background-tasks/persistent),
  [alarms](https://developer.android.com/develop/background-work/services/alarms),
  [battery optimisation](https://developer.android.com/develop/background-work/background-tasks/optimize-battery)). The documented route to timely delivery is high-priority FCM, which this app deliberately does not use.
- The docs do not cover manufacturer (for example Samsung) background limits beyond saying makers set their own criteria. WorkManager reschedules its work after reboot itself.
- Gaps in the docs: Doze window spacing, the flex-interval minimum value (docs say 15 minutes in one place), and the maximum backoff value.

What the app does is consistent with this (15-minute period, connected-network constraint, backoff on transient errors, scheduled on sign-in with `UPDATE` so
timing survives app updates, no foreground service or exact alarms), so no behaviour was changed. Expect alerts to arrive within roughly 15 to 60 minutes when the phone is in use and
later after long idle spells in Doze; the server keeps alerts in the feed and the poll hands over everything newer than the cursor, so a late run loses nothing, and a notification for an entry older
than 12 hours is skipped by design (it stays in the feed).

## Not verified without the owner's phone

Real fold bounds and state reporting on a Galaxy Z Fold (including tabletop posture), window insets and system bars, the system splash and themed icon, the window
background colour at cold start, predictive back, TalkBack, the real font-scale setting, install and launch (no emulator or device was available), the notification
permission flow and the "Mark read" action, a notification tap opening the work order (cold start and while running) with Back landing sensibly, the system biometric prompt and the
real Keystore-backed device key (ECDH with a hardware key, key invalidation on a new fingerprint), FLAG_SECURE hiding customer names in Recents, how often the 15-minute job really runs
on that phone with the screen off, and signing and installing the release APK.
