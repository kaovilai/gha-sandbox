#!/usr/bin/env bash
# macOS runner. Pass 1: build app + capture screenshots via upstream showcase.
# Pass 2 (--skip-build): same flow while `simctl io recordVideo` records the booted simulator.
set -uxo pipefail
out=${OUT_DIR:-out/ios-app}
mkdir -p "$out"
root=$(pwd)
args=(--platform ios --device iphone-6.9 --scene threads --scene thread --appearance dark)

cd target
# Free runners are slower than upstream's: first Metro bundle can exceed the hard-coded
# 90-120 s scene waits. Patch our throwaway checkout only.
perl -pi -e 's/waitForScene\(120_000\)/waitForScene(360_000)/; s/timeoutMs = 90_000,/timeoutMs = 360_000,/' scripts/mobile-showcase.ts
# iOS simulators share the host loopback; the runner's LAN IPv4 (upstream's default Metro host
# for iOS) is unreachable from the simulator, leaving the dev launcher on "Searching...".
perl -pi -e 's/const metroHost = hasIos \? lanIpv4Address\(\) : "127\.0\.0\.1";/const metroHost = "127.0.0.1";/' scripts/mobile-showcase.ts
grep -q 'const metroHost = "127.0.0.1";' scripts/mobile-showcase.ts || echo "WARN: metroHost patch did not apply"
python3 "$root/scripts/patch-showcase-ios.py" scripts/mobile-showcase.ts
# Diagnostics: periodic simulator screenshots + app log, to see why a scene never renders.
mkdir -p "$out/diag"
( i=0; while :; do sleep 45; i=$((i+1)); xcrun simctl io booted screenshot "$out/diag/t$(printf %03d "$i").png" >/dev/null 2>&1 || true; done ) &
diag1=$!
( until xcrun simctl list devices | grep -q '(Booted)'; do sleep 2; done
  xcrun simctl spawn booted log stream --level debug --style compact \
    --predicate 'process == "T3Code" OR process == "SpringBoard" OR subsystem == "com.apple.CFNetwork"' > "$out/diag/app.log" 2>&1 ) &
diag2=$!
pnpm screenshots:mobile "${args[@]}" 2>&1 | tee "$out/pass1.log"
rc1=${PIPESTATUS[0]}
kill "$diag1" "$diag2" 2>/dev/null || true
pkill -f 'simctl spawn booted log stream' 2>/dev/null || true
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
