#!/usr/bin/env bash
# Serve the checkout root. cwd = target checkout.
# Contract: log to $APP_LOG, write the URL the scenario should open to $APP_URL_FILE.
set -euo pipefail
nohup python3 -m http.server 8000 --bind 127.0.0.1 > "$APP_LOG" 2>&1 &
for _ in $(seq 1 30); do
  curl -fsS -o /dev/null http://127.0.0.1:8000/ && break
  sleep 1
done
printf '%s' "http://127.0.0.1:8000/" > "$APP_URL_FILE"
