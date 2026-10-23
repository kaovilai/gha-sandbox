#!/usr/bin/env bash
# t3code-mock "start": does NOT boot the app. One isolated T3 Code instance is booted PER SCENARIO by
# mockkit/lib/boot.mjs (called from scenario.mjs), so no scenario sees another one's threads, projects or files.
# This step only validates the toolchain and hands the target checkout path to the scenario step.
# cwd = target checkout. Contract: log to $APP_LOG, write a URL into $APP_URL_FILE (placeholder; scenario.mjs sets the real one).
set -euo pipefail

command -v vp >/dev/null || { echo "vp (Vite+) not on PATH"; exit 1; }
command -v xvfb-run >/dev/null || { echo "xvfb-run not on PATH"; exit 1; }
test -f scripts/dev-runner.ts || { echo "not a t3code checkout (scripts/dev-runner.ts missing) in $(pwd)"; exit 1; }

{
  echo "MOCKKIT_TARGET=$(pwd)"
  echo "MOCKKIT_APP_LOG=$APP_LOG"
} >> "${GITHUB_ENV:-/dev/null}"

: > "$APP_LOG"
printf '%s' "http://127.0.0.1:0/" > "$APP_URL_FILE"
echo "mockkit: target=$(pwd); apps boot per scenario"
