#!/bin/sh
# Starts the real tracker Worker code locally (fresh local database, nothing remote), runs the opt-in integration tests against it, stops it.
# Needs JAVA_HOME / ANDROID_HOME set as for any build and `npm ci` done in tracker-worker.
set -e
here=$(cd "$(dirname "$0")" && pwd)
port=${1:-8799}
cd "$here/../../tracker-worker"
node "$here/local-server.mjs" serve "$port" > "${TMPDIR:-/tmp}/linkpearl-local-server.log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null; wait $pid 2>/dev/null; true' EXIT INT TERM
i=0; until curl -s "http://127.0.0.1:$port/__ctl/ping" >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 100 ] && { echo "server did not start"; cat "${TMPDIR:-/tmp}/linkpearl-local-server.log"; exit 1; }; sleep 0.2; done
cd "$here/.."
LINKPEARL_LOCAL_SERVER="http://127.0.0.1:$port" ./gradlew :app:cleanTestDebugUnitTest :app:testDebugUnitTest --tests '*LocalServerIntegrationTest' --tests '*WholeAppIntegrationTest' -q
