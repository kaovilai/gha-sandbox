#!/usr/bin/env bash
# Runs the target's Electron dev app under Xvfb; captures real-desktop screenshot + recording.
set -euxo pipefail
out=${OUT_DIR:-out/desktop}
mkdir -p "$out"
export DISPLAY=:99
W=1440 H=900

Xvfb :99 -screen 0 ${W}x${H}x24 -nolisten tcp &
sleep 2

# Chromium SUID sandbox helper, if electron ships one.
for sb in $(find target/node_modules -name chrome-sandbox 2>/dev/null | head -3); do
  sudo chown root:root "$sb" && sudo chmod 4755 "$sb" || true
done

cd target
if [ "${DESKTOP_MODE:-built}" = dev ]; then
  # Dev mode always opens a detached DevTools window (DesktopWindow.ts isDevelopment).
  nohup vp run dev:desktop --home-dir "${RUNNER_TEMP:-/tmp}/t3home" > "$out/desktop.log" 2>&1 &
else
  if [ "${BUILD_CACHE_HIT:-}" = true ] && [ -f apps/desktop/dist-electron/boot.cjs ]; then
    echo "exact-sha build outputs restored from cache; skipping build" | tee "$out/build.log"
  else
    vp run build:desktop > "$out/build.log" 2>&1 || { tail -60 "$out/build.log"; exit 1; }
  fi
  T3CODE_HOME="${RUNNER_TEMP:-/tmp}/t3home" nohup vp run start:desktop > "$out/desktop.log" 2>&1 &
fi
dev=$!
cd ..

# Belt and braces: keep any DevTools window unmapped for the whole run.
( while :; do
    for d in $(xdotool search --onlyvisible --name '^Developer Tools' 2>/dev/null || true); do
      xdotool windowunmap "$d" || true
    done
    sleep 1
  done ) &

# Wait for the app window (up to 5 min: dev build + electron start).
win=
for i in $(seq 1 150); do
  win=$(xdotool search --onlyvisible --name '^T3 Code' 2>/dev/null | head -1 || true)
  [ -n "$win" ] && break
  kill -0 "$dev" 2>/dev/null || { echo "dev process exited"; break; }
  sleep 2
done
xwininfo -root -tree > "$out/windows.txt" || true
if [ -z "$win" ]; then tail -80 "$out/desktop.log"; echo "no window appeared"; exit 1; fi

xdotool windowsize "$win" $W $H || true
xdotool windowmove "$win" 0 0 || true
sleep 20   # let the embedded server + UI settle

import -window root "$out/desktop-first-run.png"
# First-run onboarding (Connect > Agents > Projects): Enter takes the default action each step.
for i in 1 2 3 4 5; do
  xdotool windowfocus "$win" || true
  xdotool key Return || true
  sleep 2
done
# Last step ("Import your projects") ignores Enter/Escape; click "Do not import projects".
xdotool mousemove 832 577 click 1 || true
sleep 4
import -window root "$out/desktop.png"

# 12 s real-desktop recording with some pointer motion.
ffmpeg -loglevel error -y -f x11grab -video_size ${W}x${H} -framerate 15 -i :99 -t 12 \
  -c:v libx264 -pix_fmt yuv420p "$out/recording.mp4" &
rec=$!
for x in 200 600 1000 600 200; do xdotool mousemove $x 450; sleep 2; done
wait "$rec" || true

kill "$dev" 2>/dev/null || true
ls -la "$out"
