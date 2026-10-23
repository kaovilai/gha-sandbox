#!/usr/bin/env bash
# Start the target app. cwd = target checkout.
# Contract: log to $APP_LOG, write the URL the scenario should open to $APP_URL_FILE.
set -euo pipefail
nohup xvfb-run -a vp run dev --home-dir "${RUNNER_TEMP:-/tmp}/t3home" > "$APP_LOG" 2>&1 &
url=
for _ in $(seq 1 90); do
  url=$(grep -m1 -oE 'pairingUrl: *[^ ]+' "$APP_LOG" | sed 's/pairingUrl: *//' || true)
  [ -n "$url" ] && break
  sleep 2
done
if [ -z "$url" ]; then cat "$APP_LOG"; echo "no pairingUrl"; exit 1; fi
printf '%s' "$url" > "$APP_URL_FILE"
