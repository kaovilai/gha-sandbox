#!/usr/bin/env bash
# macOS runner. Pass 1: build app + capture screenshots via upstream showcase.
# Pass 2 (--skip-build): same flow while `simctl io recordVideo` records the booted simulator.
set -uxo pipefail
out=${OUT_DIR:-out/ios-app}
mkdir -p "$out"
root=$(pwd)
args=(--platform ios --device iphone-6.9 --scene threads --scene thread --appearance dark)

cd target
# Reuse the DerivedData-cached app when present: the native compile is the slow (60+ min) part.
if [ -d apps/mobile/.showcase/ios-derived-data/Build/Products/Debug-iphonesimulator/T3Code.app ]; then
  echo "reusing cached T3Code.app (--skip-build)"
  args+=(--skip-build)
fi
# Free runners are slower than upstream's: first Metro bundle can exceed the hard-coded
# 90-120 s scene waits. Patch our throwaway checkout only.
# Pairing tokens expire after 5 min, so retry the first scene quickly and often (4 x 150 s)
# instead of upstream's 2 x 120 s; later scenes keep a generous 360 s.
perl -pi -e 's/waitForScene\(120_000\)/waitForScene(150_000)/; s/timeoutMs = 90_000,/timeoutMs = 360_000,/; s/attempt < 2;/attempt < 4;/; s/const isLastAttempt = attempt === 1;/const isLastAttempt = attempt === 3;/' scripts/mobile-showcase.ts
grep -q 'attempt < 4;' scripts/mobile-showcase.ts || echo "WARN: retry patch did not apply"

# iOS simulators share the host loopback; the runner's LAN IPv4 (upstream's default Metro host
# for iOS) is unreachable from the simulator, leaving the dev launcher on "Searching...".
perl -pi -e 's/const metroHost = hasIos \? lanIpv4Address\(\) : "127\.0\.0\.1";/const metroHost = "127.0.0.1";/' scripts/mobile-showcase.ts
grep -q 'const metroHost = "127.0.0.1";' scripts/mobile-showcase.ts || echo "WARN: metroHost patch did not apply"
[ "${IOS_DEEPLINK:-0}" = 1 ] && python3 "$root/scripts/patch-showcase-ios.py" scripts/mobile-showcase.ts || true
python3 "$root/scripts/patch-showcase-warm.py" scripts/mobile-showcase.ts
# Diagnostics: periodic simulator screenshots + app log, to see why a scene never renders.
mkdir -p "$out/diag"
( i=0; while :; do sleep 20; i=$((i+1)); xcrun simctl io booted screenshot "$out/diag/t$(printf %03d "$i").png" >/dev/null 2>&1 || true; done ) &
diag1=$!
# Metro answers the dev-client manifest in 7-25 s on 3 vCPUs; the launcher times out at 10 s.
# Front it with a caching proxy and point the app's Metro URL at the proxy (:8200).
perl -pi -e 's/const metroUrl = `http:\/\/\$\{metroHost\}:\$\{config\.metroPort\}\?/const metroUrl = `http:\/\/\$\{metroHost\}:8200?/' scripts/mobile-showcase.ts
grep -q 'metroHost}:8200?' scripts/mobile-showcase.ts || echo "WARN: metroUrl proxy patch did not apply"
node "$root/scripts/metro-manifest-proxy.mjs" > "$out/diag/proxy.log" 2>&1 &
diag2=$!
# Output goes to a file, not a pipe: with --keep-running, Metro stays alive holding stdout and
# would keep `| tee` from ever seeing EOF.
if [ "${IOS_LIVE:-0}" = 1 ]; then
  # Live mock threads (mockkit): needs the kept servers/simulator; the coordinator must not pull the app back.
  python3 "$root/scripts/patch-showcase-live.py" apps/mobile/src/features/showcase/ShowcaseCaptureCoordinator.tsx || echo "WARN: live-nav patch failed"
fi
if [ "${IOS_KEEP_RUNNING:-0}" = 1 ]; then
  pnpm screenshots:mobile "${args[@]}" --keep-running > "$out/pass1.log" 2>&1
  rc1=$?
else
  # Record the whole run from first boot; the last seconds (final capture) are trimmed below.
  ( until xcrun simctl list devices | grep -q '(Booted)'; do sleep 2; done
    xcrun simctl io booted recordVideo --codec h264 --force "$out/full.mp4" ) &
  pnpm screenshots:mobile "${args[@]}" > "$out/pass1.log" 2>&1
  rc1=$?
  pkill -INT -f 'simctl io booted recordVideo' || true
  sleep 5
  # Whole-run recording; publish-evidence.sh keeps only the tail (final capture) for MP4/GIF.
  if [ -s "$out/full.mp4" ]; then
    mv "$out/full.mp4" "$out/recording.mp4"
    rm -f "$out"/full.mp4.sb-* 2>/dev/null || true
  fi
fi
tail -40 "$out/pass1.log" | cut -c1-200
mkdir -p "$out/screenshots"
cp -r artifacts/app-store/screenshots/apple/. "$out/screenshots/" 2>/dev/null || true

if [ "$rc1" -eq 0 ] && [ "${IOS_LIVE:-0}" = 1 ]; then
  sroot=$(sed -n 's/^Showcase environments kept at \(.*\) (.*/\1/p' "$out/pass1.log" | tail -1)
  echo "showcase root: $sroot"
  LIVE_OUT="$out/live" LIVE_SCENARIOS="${LIVE_SCENARIOS:-s40 s41 s42}" bash "$root/scripts/mobile-live.sh" ios "$sroot" 2>&1 | tee "$out/live.log"
  echo "mobile-live exit ${PIPESTATUS[0]}"
  pkill -f 'apps/server/src/bin.ts serve' 2>/dev/null; pkill -f 'expo start' 2>/dev/null; true
elif [ "$rc1" -eq 0 ] && [ "${IOS_KEEP_RUNNING:-0}" = 1 ]; then
  # Record a short clip from the still-running simulator while AXe scrolls the app.
  udid=$(xcrun simctl list devices booted -j | jq -r '[.devices[][] | select(.state=="Booted")][0].udid // empty')
  if [ -n "$udid" ]; then
    xcrun simctl io "$udid" recordVideo --codec h264 --force "$out/recording.mp4" &
    rec=$!
    sleep 3
    for _ in 1 2 3; do
      axe swipe --start-x 220 --start-y 600 --end-x 220 --end-y 250 --duration 0.6 --udid "$udid" || true
      sleep 2
      axe swipe --start-x 220 --start-y 250 --end-x 220 --end-y 600 --duration 0.6 --udid "$udid" || true
      sleep 2
    done
    kill -INT "$rec" 2>/dev/null || true
    wait "$rec" 2>/dev/null || true
  else
    echo "no booted simulator; skipping recording"
  fi
fi
kill "$diag1" "$diag2" 2>/dev/null || true
cd "$root"
find "$out" -type f | head -40
exit "$rc1"
