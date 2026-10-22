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
nohup vp run dev:desktop --home-dir "${RUNNER_TEMP:-/tmp}/t3home" > "$out/desktop.log" 2>&1 &
dev=$!
cd ..

# Wait for the app window (up to 5 min: dev build + electron start).
win=
for i in $(seq 1 150); do
  win=$(xdotool search --onlyvisible --name '.' 2>/dev/null | head -1 || true)
  [ -n "$win" ] && break
  kill -0 "$dev" 2>/dev/null || { echo "dev process exited"; break; }
  sleep 2
done
xwininfo -root -tree > "$out/windows.txt" || true
if [ -z "$win" ]; then tail -80 "$out/desktop.log"; echo "no window appeared"; exit 1; fi

xdotool windowsize "$win" $W $H || true
xdotool windowmove "$win" 0 0 || true
sleep 20   # let the embedded server + UI settle

import -window root "$out/desktop.png"

# 12 s real-desktop recording with some pointer motion.
ffmpeg -loglevel error -y -f x11grab -video_size ${W}x${H} -framerate 15 -i :99 -t 12 \
  -c:v libx264 -pix_fmt yuv420p "$out/recording.mp4" &
rec=$!
for x in 200 600 1000 600 200; do xdotool mousemove $x 450; sleep 2; done
wait "$rec" || true

kill "$dev" 2>/dev/null || true
ls -la "$out"
