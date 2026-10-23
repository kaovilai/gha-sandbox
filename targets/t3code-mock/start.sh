#!/usr/bin/env bash
# Start t3code with the mockkit AI provider seeded (no API keys, no cloud).
# cwd = target checkout. Contract: log to $APP_LOG, write the URL to open into $APP_URL_FILE.
set -euo pipefail

HARNESS=${GITHUB_WORKSPACE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
TMP=${RUNNER_TEMP:-/tmp}
HOME_DIR="$TMP/t3home"
WS="$TMP/mockws"
MK="$TMP/mockkit"
mkdir -p "$MK"

# --- deterministic, offline, no cloud ---------------------------------------------------------
export T3CODE_TELEMETRY_ENABLED=false T3CODE_OTEL_SDK_DISABLED=true T3CODE_NO_BROWSER=1 T3CODE_DISABLE_AUTO_UPDATE=true
unset T3CODE_RELAY_URL || true
for v in $(env | grep -oE '^(T3CODE_CLERK_[A-Z_]*|VITE_CLERK_[A-Z_]*)' || true); do unset "$v"; done

# --- mock env (also baked into providerInstances[*].environment by seed/settings.mjs) -----------
export MOCK_LOG="$MK/mock.ndjson" MOCK_CONTROL_DIR="$MK/control" MOCK_PACE="${MOCK_PACE:-real}" MOCK_SEED="${MOCK_SEED:-1}"
rm -rf "$MK/control" "$MOCK_LOG"

# --- workspace the mock sessions will edit ----------------------------------------------------
bash "$HARNESS/mockkit/seed/workspace.sh" "$WS"

nohup xvfb-run -a vp run dev --home-dir "$HOME_DIR" > "$APP_LOG" 2>&1 &

url=
for _ in $(seq 1 90); do
  url=$(grep -m1 -oE 'pairingUrl: *[^ ]+' "$APP_LOG" | sed 's/pairingUrl: *//' || true)
  [ -n "$url" ] && break
  sleep 2
done
if [ -z "$url" ]; then cat "$APP_LOG"; echo "no pairingUrl"; exit 1; fi

# --- discover stateDir (HOME/userdata vs HOME/dev/userdata): dir holding environment-id ----------
state=
for _ in $(seq 1 60); do
  f=$(find "$HOME_DIR" -name environment-id 2>/dev/null | head -1 || true)
  if [ -n "$f" ]; then state=$(dirname "$f"); break; fi
  sleep 1
done
if [ -z "$state" ]; then
  echo "WARN: environment-id not found; tree:"; find "$HOME_DIR" -maxdepth 3 | head -50
  state="$HOME_DIR/userdata"
fi
echo "mockkit: stateDir=$state"
node "$HARNESS/mockkit/seed/settings.mjs" "$state"

# settings.json is hot-reloaded; give the provider registry time to re-probe the mock
sleep 10

{
  echo "MOCKKIT_STATE_DIR=$state"
  echo "MOCKKIT_WS=$WS"
  echo "MOCK_LOG=$MOCK_LOG"
  echo "MOCK_CONTROL_DIR=$MOCK_CONTROL_DIR"
  echo "MOCKKIT_APP_LOG=$APP_LOG"
} >> "${GITHUB_ENV:-/dev/null}"

printf '%s' "$url" > "$APP_URL_FILE"
