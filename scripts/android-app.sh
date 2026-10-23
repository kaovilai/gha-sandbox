#!/usr/bin/env bash
# Inside android-emulator-runner (emulator booted). Pass 1: build debug APK + capture
# screenshots via upstream showcase. Pass 2 (--skip-build): same flow while screenrecord runs.
set -uxo pipefail
out=${OUT_DIR:-out/android-app}
mkdir -p "$out"
root=$(pwd)
args=(--platform android --device pixel --scene threads --scene thread --appearance dark)

cd target
# Reuse the cached debug APK when present (native build is the slow part).
if [ -f apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk ]; then
  echo "reusing cached app-debug.apk (--skip-build)"
  args+=(--skip-build)
fi
# Free runners are slower than upstream's: first Metro bundle can exceed the hard-coded
# 90-120 s scene waits. Patch our throwaway checkout only.
perl -pi -e 's/waitForScene\(120_000\)/waitForScene(900_000)/; s/timeoutMs = 90_000,/timeoutMs = 900_000,/' scripts/mobile-showcase.ts
if [ "${LIVE:-0}" = 1 ]; then
  # Live mock threads (mockkit): keep servers/Metro/emulator/app up after the capture pass, then drive them.
  python3 "$root/scripts/patch-showcase-live.py" apps/mobile/src/features/showcase/ShowcaseCaptureCoordinator.tsx || echo "WARN: live-nav patch failed"
  # file, not a pipe: kept Metro holds stdout open and would stop `| tee` from ever seeing EOF
  pnpm screenshots:mobile "${args[@]}" --keep-running > "$out/pass1.log" 2>&1
  rc1=$?
  tail -30 "$out/pass1.log" | cut -c1-200
else
  pnpm screenshots:mobile "${args[@]}" 2>&1 | tee "$out/pass1.log"
  rc1=${PIPESTATUS[0]}
fi
mkdir -p "$out/screenshots"
cp -r artifacts/app-store/screenshots/google-play/. "$out/screenshots/" 2>/dev/null || true

if [ "$rc1" -eq 0 ] && [ "${LIVE:-0}" = 1 ]; then
  sroot=$(sed -n 's/^Showcase environments kept at \(.*\) (.*/\1/p' "$out/pass1.log" | tail -1)
  echo "showcase root: $sroot"
  LIVE_OUT="$out/live" bash "$root/scripts/mobile-live.sh" android "$sroot" 2>&1 | tee "$out/live.log"
  live_rc=${PIPESTATUS[0]}
  echo "mobile-live exit $live_rc"
  pkill -f 'apps/server/src/bin.ts serve' 2>/dev/null; pkill -f 'expo start' 2>/dev/null; true
elif [ "$rc1" -eq 0 ]; then
  # screenrecord caps at 180 s; chain segments until the capture pass ends.
  ( n=0; while :; do adb shell screenrecord --time-limit 170 "/data/local/tmp/rec$n.mp4" || true; n=$((n+1)); done ) &
  loop=$!
  pnpm screenshots:mobile "${args[@]}" --skip-build 2>&1 | tee "$out/pass2.log"
  kill "$loop" 2>/dev/null || true
  adb shell pkill -2 screenrecord || true
  sleep 3
  for f in $(adb shell ls /data/local/tmp/ | tr -d '\r' | grep '^rec.*\.mp4$'); do
    adb pull "/data/local/tmp/$f" "$out/$f" || true
  done
fi
cd "$root"
find "$out" -type f | head -40
[ "$rc1" -eq 0 ] && rc1=${live_rc:-0}
exit "$rc1"
