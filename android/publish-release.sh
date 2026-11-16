#!/usr/bin/env bash
# Publish a signed Linkpearl APK as the latest build, for in-app updates (GET /v1/agents/m/update on the tracker Worker; tracker-worker/MOBILE-API-update.md).
#
#   android/publish-release.sh <apk> [versionName versionCode]
#   NOTES="What changed" android/publish-release.sh app/build/outputs/apk/release/app-release.apk
#
# Reads versionName/versionCode from the APK with aapt (or aapt2, or apkanalyzer) from the Android SDK when one is found; otherwise pass both as
# arguments. Arguments, when given, must agree with the APK. Uploads to the R2 bucket linkpearl-releases (bound as RELEASES), from tracker-worker/:
#   1. linkpearl/Linkpearl-<versionName>.apk
#   2. linkpearl/latest.json  { code, name, size, sha256[, notes] }   (last, so latest.json never names an APK that is not there yet)
# Needs `npx wrangler login` (or CLOUDFLARE_API_TOKEN) and the bucket: npx wrangler r2 bucket create linkpearl-releases
# DRY_RUN=1 prints what it would upload and stops.
set -euo pipefail

BUCKET=linkpearl-releases
here="$(cd "$(dirname "$0")" && pwd)"
worker="$here/../tracker-worker"

usage() { echo "usage: $0 <apk> [versionName versionCode]   (NOTES=\"...\" optional, DRY_RUN=1 to check only)" >&2; exit 2; }
[ $# -eq 1 ] || [ $# -eq 3 ] || usage
apk="$1"; [ -f "$apk" ] || { echo "no such file: $apk" >&2; exit 1; }
apk="$(cd "$(dirname "$apk")" && pwd)/$(basename "$apk")"
argName="${2:-}"; argCode="${3:-}"

# ---- versionName / versionCode from the APK
find_tool() { # an SDK build tool: on PATH, else the newest build-tools/ under ANDROID_HOME / ANDROID_SDK_ROOT / the usual SDK folders
  local t="$1" sdk d
  if command -v "$t" >/dev/null 2>&1; then command -v "$t"; return; fi
  for sdk in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
    [ -n "$sdk" ] && [ -d "$sdk/build-tools" ] || continue
    d="$(ls -1d "$sdk"/build-tools/*/ 2>/dev/null | sort -V | tail -1)"
    [ -n "$d" ] && [ -x "$d$t" ] && { echo "$d$t"; return; }
  done
  return 1
}
name=""; code=""
for t in aapt aapt2; do
  if tool="$(find_tool "$t")"; then
    badging="$("$tool" dump badging "$apk" 2>/dev/null | grep -m1 '^package:' || true)"
    name="$(printf '%s' "$badging" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")"
    code="$(printf '%s' "$badging" | sed -n "s/.*versionCode='\([^']*\)'.*/\1/p")"
    [ -n "$name" ] && [ -n "$code" ] && break
  fi
done
if { [ -z "$name" ] || [ -z "$code" ]; } && tool="$(command -v apkanalyzer 2>/dev/null || { [ -n "${ANDROID_HOME:-}" ] && ls "$ANDROID_HOME"/cmdline-tools/*/bin/apkanalyzer 2>/dev/null | tail -1; })" && [ -n "$tool" ]; then
  name="$("$tool" manifest version-name "$apk" 2>/dev/null || true)"
  code="$("$tool" manifest version-code "$apk" 2>/dev/null || true)"
fi
if [ -n "$name" ] && [ -n "$code" ]; then
  if [ -n "$argName" ] && { [ "$argName" != "$name" ] || [ "$argCode" != "$code" ]; }; then
    echo "the APK says $name ($code), the arguments say $argName ($argCode): not publishing" >&2; exit 1
  fi
else
  [ -n "$argName" ] || { echo "no aapt/aapt2/apkanalyzer found: pass versionName and versionCode" >&2; usage; }
  name="$argName"; code="$argCode"
fi
# the same checks the Worker makes before it believes latest.json (src/mobile-update.js latestOf)
[[ "$code" =~ ^[1-9][0-9]{0,8}$ ]] || { echo "versionCode must be a positive integer: $code" >&2; exit 1; }
[[ "$name" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$ ]] || { echo "versionName must be letters, digits, . _ + - (40 at most): $name" >&2; exit 1; }

# ---- size and sha256
size="$(wc -c < "$apk" | tr -d ' ')"
if command -v sha256sum >/dev/null 2>&1; then sha="$(sha256sum "$apk" | cut -d' ' -f1)"; else sha="$(shasum -a 256 "$apk" | cut -d' ' -f1)"; fi

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
CODE="$code" NAME="$name" SIZE="$size" SHA="$sha" NOTES="${NOTES:-}" node -e '
  const o = { code: Number(process.env.CODE), name: process.env.NAME, size: Number(process.env.SIZE), sha256: process.env.SHA };
  if (process.env.NOTES.trim()) o.notes = process.env.NOTES.trim();
  process.stdout.write(JSON.stringify(o));' > "$tmp/latest.json"

echo "Linkpearl $name (versionCode $code), $size bytes, sha256 $sha"
echo "  $BUCKET/linkpearl/Linkpearl-$name.apk"
echo "  $BUCKET/linkpearl/latest.json  $(cat "$tmp/latest.json")"
[ -z "${DRY_RUN:-}" ] || { echo "DRY_RUN: nothing uploaded"; exit 0; }

cd "$worker"
npx wrangler r2 object put "$BUCKET/linkpearl/Linkpearl-$name.apk" --file "$apk" --content-type application/vnd.android.package-archive --remote
npx wrangler r2 object put "$BUCKET/linkpearl/latest.json" --file "$tmp/latest.json" --content-type application/json --cache-control no-store --remote
echo "Published. Phones see it on their next update check."
