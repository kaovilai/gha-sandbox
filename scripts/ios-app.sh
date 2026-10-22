#!/usr/bin/env bash
# macOS runner. Pass 1: build app + capture screenshots via upstream showcase.
# Pass 2 (--skip-build): same flow while `simctl io recordVideo` records the booted simulator.
set -uxo pipefail
out=${OUT_DIR:-out/ios-app}
mkdir -p "$out"
root=$(pwd)
args=(--platform ios --device iphone-6.9 --scene threads --scene thread --appearance dark)

cd target
pnpm screenshots:mobile "${args[@]}" 2>&1 | tee "$out/pass1.log"
rc1=${PIPESTATUS[0]}
mkdir -p "$out/screenshots"
cp -r artifacts/app-store/screenshots/apple/. "$out/screenshots/" 2>/dev/null || true

if [ "$rc1" -eq 0 ]; then
  (
    until xcrun simctl list devices | grep -q '(Booted)'; do sleep 2; done
    xcrun simctl io booted recordVideo --codec h264 --force "$out/recording.mp4"
  ) &
  watcher=$!
  pnpm screenshots:mobile "${args[@]}" --skip-build 2>&1 | tee "$out/pass2.log"
  pkill -INT -f 'simctl io booted recordVideo' || true
  sleep 4
  kill "$watcher" 2>/dev/null || true
fi
cd "$root"
find "$out" -type f | head -40
exit "$rc1"
