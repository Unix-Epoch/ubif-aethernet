# Linkpearl phone API: app updates (`/v1/agents/m/update…`)

Source: `src/mobile-update.js`, tests: `test/mobile-update.test.mjs` (wrangler's local R2; the JSON below is real output from that test, on an invented APK).
Auth as for every `/v1/agents/m/…` route (app key header + `Authorization: Bearer <id>.<token>`, approved phone), the APK download included.

Releases live in the R2 bucket `linkpearl-releases`, bound to the tracker Worker as `RELEASES` (`wrangler.toml`):
```
linkpearl/latest.json            {"code":6,"name":"1.2.0","size":300000,"sha256":"<64 hex>","notes":"…"}   (notes optional)
linkpearl/Linkpearl-<name>.apk   the signed APK
```
`android/publish-release.sh <apk>` writes both (APK first, then `latest.json`).

## `GET /v1/agents/m/update`

```json
{"latest":{"code":6,"name":"1.2.0","size":300000,"sha256":"1b28064f4d6462f8e9116e726b0171876a2f81cd261f02c179c5d0c75c3effc4","notes":"Prices and in-app updates."},
 "min":{"code":1,"name":"1.0.0"}}
```
- `latest`: the published build (`code` = Android `versionCode`, `name` = `versionName`, `size` in bytes, `sha256` lower-case hex of the APK, `notes` only when given), or `null` when nothing is published, `latest.json` is missing or not this shape, or the bucket is not bound or not reachable. Never a 500 for any of those.
- `min`: the oldest build the server accepts (`MIN_APP` in `src/mobile-prefs.js`, the same value as `/prefs`' `minApp`).
- The app: `latest.code > own versionCode` → offer the update; `own versionCode < min.code` → the update is required (block the app until installed).

## `GET /v1/agents/m/update/apk?code=<versionCode>`

The APK bytes, streamed from R2: `200`, `content-type: application/vnd.android.package-archive`, `content-length: <size>`, `content-disposition: attachment; filename="Linkpearl-<name>.apk"`, `cache-control: no-store`.
- Only the latest build is served: `code` must equal `latest.code` (else `404 {"error":"no such build"}`, also when the APK file is missing or nothing is published). `code` missing or not digits: `400 {"error":"code: a versionCode"}`.
- Verify before installing: the byte count equals `size` and SHA-256 equals `sha256`; on a mismatch discard the file. Install with the package installer (`REQUEST_INSTALL_PACKAGES`); Android also refuses an APK not signed with the installed app's key.

Other methods: `405`. Other paths (`/update/apk/6`, `/update/x`): `404`.

## Publishing (owner, from a Mac with the Android SDK)

1. Once: `cd tracker-worker && npx wrangler r2 bucket create linkpearl-releases` (needs R2 on the account), then deploy the tracker Worker (the `RELEASES` binding is in `wrangler.toml`; deploying with the binding before the bucket exists fails).
2. Each release: build the signed release APK, then `NOTES="What changed" android/publish-release.sh android/app/build/outputs/apk/release/app-release.apk`. It reads `versionName`/`versionCode` with `aapt`/`aapt2`/`apkanalyzer` (Android SDK build-tools), or takes them as arguments (`publish-release.sh <apk> 1.2.0 6`); computes size and sha256; uploads with `npx wrangler r2 object put … --remote`. `DRY_RUN=1` prints what it would upload.
