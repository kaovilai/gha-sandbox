#!/usr/bin/env bash
# mobile-live.sh <android|ios> <showcase-root>   (cwd = target checkout, after a `--keep-running` showcase pass)
#
# The upstream showcase leaves its 3 seeded servers (<root>/environments/<id>, ports ~4936x), Metro, the
# emulator/simulator and the paired app running. This script then makes the app show LIVE mock threads:
#   1. hot-seed mockkit settings into <baseDir>/userdata (grok = mock agent; other providers kept; supervised default)
#   2. start threads via the server CLI (`bin.ts thread start`, MCP-over-HTTP t3_thread_launch)
#   3. drive the app (tap rows/buttons by label), poll the UI tree (uiautomator dump | AXe describe-ui) and the server
#      (`thread show --json`), screenshot + record each scenario.
# Scenarios: s40 live streaming turn, s41 approval tap + resolve, s42 user-question card.
# Env: LIVE_OUT (output dir, required), LIVE_SCENARIOS (default "s40 s41 s42"), MOCK_PACE,
#   MOCK_PROVIDER = grok (default) | codex | claude | both | all: provider flavor of the threads. grok: Grok mock (titles "Mock ...",
#   provider grok / grok-build, files in $LIVE_OUT). codex: Codex app-server mock (titles "Codex ...", provider codex / gpt-6-astra, files
#   in $LIVE_OUT/codex/). claude: Claude stream-json mock (titles "Claude ...", provider claudeAgent / claude-fable-5-1, files in
#   $LIVE_OUT/claude/, results claude-s4x). both: grok pass, then codex pass. all: grok, codex, then claude (same server, same app session).
set -uo pipefail
plat=${1:?android|ios}
sroot=${2:?showcase root}
here=$(cd "$(dirname "$0")" && pwd)
kit=$(cd "$here/../mockkit" && pwd)
uia="$here/uia.mjs"
out=${LIVE_OUT:?LIVE_OUT}
mkdir -p "$out/ui"
bd="$sroot/environments/moonbase-terminal"
ws="$bd/workspace/t3code"
pkg=com.t3tools.t3code
scenarios=${LIVE_SCENARIOS:-"s40 s41 s42"}
live_root=$out
case "$(echo "${MOCK_PROVIDER:-grok}" | tr 'A-Z' 'a-z')" in
  codex) mock_provider=codex; providers="codex" ;;
  claude) mock_provider=claude; providers="claude" ;;
  both)  mock_provider=both;  providers="grok codex" ;;
  all)   mock_provider=all;   providers="grok codex claude" ;;
  *)     mock_provider=grok;  providers="grok" ;;
esac
# per-pass flavor (set by use_provider): PROV/MODEL = server CLI --provider/--model, TP = thread title prefix
PROV=grok MODEL=grok-build TP=Mock PROV_BAD=0
use_provider() { # grok | codex | claude (the Claude provider instance id is claudeAgent)
  PROV=$1; [ "$1" = claude ] && PROV=claudeAgent
  case "$PROV" in
    codex)       MODEL=gpt-6-astra TP=Codex out="$live_root/codex" ;;
    claudeAgent) MODEL=claude-fable-5-1 TP=Claude out="$live_root/claude" ;;
    *)           MODEL=grok-build TP=Mock out="$live_root" ;;
  esac
  mkdir -p "$out/ui"
  navs=0
}

export MOCK_CONTROL_DIR=${RUNNER_TEMP:-/tmp}/mockkit-live/control
export MOCK_LOG="$out/mock.ndjson"
export MOCK_PACE=${MOCK_PACE:-real}
# slow runners: CLI polls + UI dumps (and the remount fallbacks below) can take minutes between a hold being reached and released
export MOCK_HOLD_TIMEOUT_MS=${MOCK_HOLD_TIMEOUT_MS:-900000}
export MOCK_KEEP_OTHER_PROVIDERS=1
export MOCK_DEFAULT_RUNTIME_MODE=approval-required
rm -rf "$MOCK_CONTROL_DIR"; mkdir -p "$MOCK_CONTROL_DIR"

log() { echo "[live $(date +%T)] $*" >&2; }
fail() { log "FAIL: $*"; }

[ -d "$bd/userdata" ] || { fail "no $bd/userdata (showcase servers not kept?)"; ls -la "$sroot" "$sroot/environments" >&2 2>/dev/null; exit 3; }

# ---- device helpers ---------------------------------------------------------------------------------------------
UDID=
if [ "$plat" = ios ]; then
  UDID=$(xcrun simctl list devices booted -j | jq -r '[.devices[][] | select(.state=="Booted")][0].udid // empty')
  [ -n "$UDID" ] || { fail "no booted simulator"; exit 3; }
  export AXE_HID_STABILIZATION_MS=${AXE_HID_STABILIZATION_MS:-1500}
fi

dump() {
  if [ "$plat" = android ]; then
    # uiautomator cannot reach "idle" while the app animates/streams and then leaves the PREVIOUS dump on disk:
    # delete first, retry, and fail (empty) rather than return a stale tree.
    local i x
    for i in 1 2 3; do
      adb shell "rm -f /sdcard/uia.xml; uiautomator dump /sdcard/uia.xml" >/dev/null 2>&1
      x=$(adb exec-out cat /sdcard/uia.xml 2>/dev/null)
      [ -n "$x" ] && { printf '%s\n' "$x"; return 0; }
      sleep 1
    done
    return 1
  else
    axe describe-ui --udid "$UDID" 2>/dev/null
  fi
}
ui_find() { dump | tee "$out/ui/last.dump" | node "$uia" find "$1"; }
# wait_ui <regex> <timeoutSec> <name>  -> prints "cx cy label" of first match
wait_ui() {
  local re=$1 to=${2:-90} name=${3:-x} t0=$SECONDS r
  while (( SECONDS - t0 < to )); do
    if r=$(ui_find "$re"); then echo "$r"; return 0; fi
    sleep 2
  done
  cp "$out/ui/last.dump" "$out/ui/timeout-$name.dump" 2>/dev/null
  log "timeout waiting for /$re/ ($name); labelled nodes now:"
  node "$uia" texts < "$out/ui/last.dump" 2>&1 | head -50 >&2
  return 1
}
tap() {
  if [ "$plat" = android ]; then adb shell input tap "$1" "$2"; else axe tap -x "$1" -y "$2" --udid "$UDID" >/dev/null 2>&1; fi
}
# tap_re <regex> <timeoutSec> <name>
tap_re() {
  local r cx cy
  r=$(wait_ui "$@") || return 1
  read -r cx cy _ <<<"$r"
  log "tap ($cx,$cy) $r"
  tap "$cx" "$cy"
}
shot() {
  if [ "$plat" = android ]; then adb exec-out screencap -p > "$out/$1.png"; else xcrun simctl io "$UDID" screenshot "$out/$1.png" >/dev/null 2>&1; fi
  log "shot $1.png ($(wc -c < "$out/$1.png") bytes)"
}
# dump the labelled nodes of the current screen next to the shot (proof of UI state; printed in the log too)
ui_state() {
  dump > "$out/ui/$1.dump"
  node "$uia" texts < "$out/ui/$1.dump" > "$out/ui/$1.txt"
  log "ui state $1: $(wc -l < "$out/ui/$1.txt") labelled nodes"
  head -40 "$out/ui/$1.txt" >&2
}
recpid=
rec_start() {
  if [ "$plat" = android ]; then
    ( adb shell screenrecord --bit-rate 4000000 --time-limit 170 "/data/local/tmp/$1.mp4" ) & recpid=$!
  else
    xcrun simctl io "$UDID" recordVideo --codec h264 --force "$out/$1.mp4" 2>/dev/null & recpid=$!
  fi
  sleep 2
}
rec_stop() {
  sleep 2
  if [ "$plat" = android ]; then
    adb shell pkill -2 screenrecord; wait "$recpid" 2>/dev/null; sleep 2
    adb pull "/data/local/tmp/$1.mp4" "$out/$1.mp4" >/dev/null 2>&1 || log "pull $1.mp4 failed"
  else
    kill -INT "$recpid" 2>/dev/null; wait "$recpid" 2>/dev/null
  fi
  log "clip $1.mp4: $(wc -c < "$out/$1.mp4" 2>/dev/null) bytes"
}
write_scene() {
  if [ "$plat" = android ]; then
    adb shell "run-as $pkg sh -c 'mkdir -p files && rm -f files/t3-showcase-ready && printf %s $1 > files/t3-showcase-scene'"
  else
    local c; c=$(xcrun simctl get_app_container "$UDID" "$pkg" data)
    printf %s "$1" > "$c/Library/Caches/T3ShowcaseScene"
  fi
}
# iOS: native-stack interactive pop = edge swipe (AXe preset); fall back to tapping the header back button.
back() {
  if [ "$plat" = android ]; then adb shell input keyevent KEYCODE_BACK
  else axe gesture swipe-from-left-edge --udid "$UDID" >/dev/null 2>&1 || axe tap -x 30 -y 70 --udid "$UDID" >/dev/null 2>&1
  fi
}

# ---- server helpers ---------------------------------------------------------------------------------------------
t3() { node apps/server/src/bin.ts "$@"; }
show_json() { t3 thread show --base-dir "$bd" --json "$1" 2>"$out/show.err"; }
# server_truth <label> <threadId>: one-line summary + raw json appended to server-truth.ndjson
server_truth() {
  local j; j=$(show_json "$2" | grep '^{' | head -1)
  [ -n "$j" ] || { log "server_truth($1): no json ($(head -c 300 "$out/show.err"))"; return 1; }
  echo "{\"label\":\"$1\",\"at\":\"$(date +%T)\",\"data\":$j}" >> "$out/server-truth.ndjson"
  local prov; prov=$(echo "$j" | jq -r '.thread.providerInstanceId // empty')
  [ "$prov" = "$PROV" ] || { log "PROVIDER MISMATCH: thread $2 runs on '$prov', expected '$PROV'"; PROV_BAD=1; }
  log "SERVER[$1] $(echo "$j" | jq -c '{status:.thread.status,pending:.thread.pendingRequestCount,provider:.thread.providerInstanceId,model:.thread.model,last:[.messages[-2:][]|{role,text:(.text|.[0:70])}]}')"
  SRV_STATUS=$(echo "$j" | jq -r '.thread.status')
  SRV_PENDING=$(echo "$j" | jq -r '.thread.pendingRequestCount')
  SRV_TEXT=$(echo "$j" | jq -r '[.messages[]|select(.role=="assistant")|.text]|join("\n")')
}
start_thread() { # <title> <prompt> -> threadId
  local i o id
  for i in $(seq 1 12); do
    o=$(t3 thread start --base-dir "$bd" --title "$1" --provider "$PROV" --model "$MODEL" --json t3code "$2" 2>"$out/start.err")
    id=$(echo "$o" | grep '^{' | head -1 | jq -r '.threadId // empty' 2>/dev/null)
    [ -n "$id" ] && { echo "$id"; return 0; }
    log "thread start try $i failed: $(head -c 300 "$out/start.err") $o"
    sleep 5
  done
  return 1
}
next() { node "$kit/ctl/mockctl.mjs" next "$@" --cwd "$ws"; }
# gate/hold names (g40, live40, g41) are reused by every pass: a release file left by an earlier pass (grok, in `both` mode) would let the
# next pass's turn run straight through its gate (codex-s40 then completes before the app opens the thread). Clear before each gated scenario.
clear_gates() { rm -rf "$MOCK_CONTROL_DIR/release" "$MOCK_CONTROL_DIR/reached"; }
# wait_server <threadId> <regex> <timeoutSec>: poll `thread show --json` until the assistant text matches
wait_server() {
  local t0=$SECONDS j
  while (( SECONDS - t0 < $3 )); do
    j=$(show_json "$1" | grep '^{' | head -1)
    if [ -n "$j" ] && echo "$j" | jq -r '[.messages[]|select(.role=="assistant")|.text]|join("\n")' | grep -Eq "$2"; then return 0; fi
    sleep 2
  done
  log "timeout waiting for server text /$2/ on $1"
  return 1
}

navs=0
open_thread() { # <title>
  local title=$1
  navs=$((navs + 1))
  if [ "$navs" -eq 1 ]; then
    # fresh from the showcase pass the app sits on its fixture thread (scene=thread): toggle thread -> threads
    write_scene thread; sleep 6; write_scene threads
  else
    back
  fi
  if ! wait_ui "$title" 25 "list-$navs" >/dev/null; then
    log "list not showing '$title'; toggling scene thread -> threads"
    write_scene thread; sleep 8; write_scene threads
    wait_ui "$title" 60 "list-toggle-$navs" >/dev/null || return 1
  fi
  sleep 1
  # a running thread's list row animates ("Working Ns"): uiautomator then often returns an empty tree. If the tap target cannot be
  # found, re-toggle the scene (thread -> threads; never BACK, which from the list leaves the app) and retry once.
  tap_re "$title" 30 "open-$navs" && return 0
  log "tap on '$title' failed; toggling scene thread -> threads and retrying"
  write_scene thread; sleep 8; write_scene threads
  sleep 2
  tap_re "$title" 60 "open-retry-$navs"
}

# The thread screen disables Stop/Approve/Submit ("This connection cannot respond to approvals / submit answers /
# control this task") while the environment's session scopes are not loaded (session state is SWR-cached 30 s and a
# failed/slow first fetch sticks until the thread is remounted). Remount after the cache is stale until the hint is gone.
ensure_operable() { # <title>
  local i
  for i in 1 2 3 4; do
    dump > "$out/ui/operable.dump" 2>/dev/null
    node "$uia" find "cannot (respond to approvals|submit answers|control this task)" < "$out/ui/operable.dump" >/dev/null || return 0
    log "thread controls disabled (scopes not loaded), try $i: sleep 35 then remount"
    sleep 35
    open_thread "$1" || return 1
    sleep 3
  done
  log "thread controls still disabled after remounts"
  return 1
}

# A running thread's view is often blank to uiautomator (animating "Working" row / stale view): remount (up to 3x, growing waits) until the text shows.
remount_until() { # <title> <regex> <tag>
  local i
  for i in 1 2 3; do
    open_thread "$1" && wait_ui "$2" $((30 + 20 * i)) "$3-r$i" >/dev/null && return 0
    log "remount $i/3 did not show /$2/"
  done
  return 1
}

results=()
record_result() { results+=("$1=$2"); echo "LIVE RESULT $1 $2"; }
rlabel() { case "$PROV" in codex) echo "codex-$1" ;; claudeAgent) echo "claude-$1" ;; *) echo "$1" ;; esac; }

# ---- 1. seed the mock provider into the running showcase server ---------------------------------------------------
log "base dir $bd"
ls "$bd/userdata" >&2
chmod +x "$kit/bin/mock-cli.sh"
MOCK_PROVIDER=$mock_provider node "$kit/seed/settings.mjs" "$bd/userdata" || { fail "seed failed"; exit 4; }
t0=$SECONDS
until grep -Eq ' (models|app-server|--output-format)' "$MOCK_CONTROL_DIR/probes.log" 2>/dev/null; do
  (( SECONDS - t0 > 90 )) && { fail "T3 never probed the mock provider (probes.log empty)"; cat "$MOCK_CONTROL_DIR/probes.log" 2>&1; break; }
  sleep 2
done
log "provider probes: $(tr '\n' ';' < "$MOCK_CONTROL_DIR/probes.log" 2>/dev/null | cut -c1-200)"
sleep 3

# ---- scenarios ----------------------------------------------------------------------------------------------------
run_s40() {
  local title="$TP live stream" tid
  clear_gates
  next live-stream gate=g40 hold=live40
  rec_start s40
  tid=$(start_thread "$title" "Stream me a progress report.") || { rec_stop s40; return 1; }
  log "s40 thread $tid"
  echo "$tid" > "$out/s40.threadid"
  open_thread "$title" || { rec_stop s40; return 1; }
  node "$kit/ctl/mockctl.mjs" wait-reached g40 60 || log "gate g40 not reached"
  sleep 2
  shot s40-turn-open-before-stream
  server_truth s40-before-stream "$tid"
  node "$kit/ctl/mockctl.mjs" release g40
  # While text streams in, uiautomator cannot get an idle tree (see dump()), so growth is proven by timed
  # screenshots + server-side assistant text; the UI tree is asserted at the quiescent held/complete states.
  sleep 5
  shot s40-streaming-early
  server_truth s40-early "$tid"
  local early_text=$SRV_TEXT
  sleep 4
  shot s40-streaming-mid
  wait_server "$tid" "Step 5 of 8" 90 || { rec_stop s40; return 1; }
  node "$kit/ctl/mockctl.mjs" wait-reached live40 60 || log "hold live40 not reached"
  sleep 3
  shot s40-streaming-held
  ui_state s40-held
  server_truth s40-held "$tid"
  local held_status=$SRV_STATUS
  log "early server text had: $(echo "$early_text" | grep -c '^Step') step line(s)"
  # A missing UI tree is NOT proof of anything: in CI run 40016905754/40019463438 (mock_provider=both) the held AND complete screenshots were
  # blank (no assistant text) while server truth was fine, i.e. the app view was stale. So when the tree lacks the text, remount the thread
  # (scene toggle, reopen) and require the text there; only then is the state proven in the UI. Never "ok" on server truth alone.
  if ! wait_ui "Step 5 of 8" 30 s40-held-ui >/dev/null; then
    log "UI lacks 'Step 5 of 8' while held (stale/blank thread view or uiautomator flake); remounting thread"
    # Claude's running thread shows an animated "Thinking" row + "Working Ns" pill: uiautomator then NEVER reaches idle and returns an EMPTY
    # tree (0 labelled nodes; run 40049775691), even though the screenshot shows Steps 1-5. An empty tree is "no tree", not "no text": for the
    # Claude pass accept the held screenshot (read it) + server truth for the HELD state only; the completed state below still needs the UI tree.
    if [ "$PROV" = claudeAgent ] && [ "$(node "$uia" texts < "$out/ui/last.dump" 2>/dev/null | wc -l)" -eq 0 ]; then
      log "HELD-UI-TREE-UNAVAILABLE: uiautomator returns no nodes while the Claude turn animates; s40-streaming-held.png + server truth are the held proof"
      echo "held-state UI tree unavailable (animated Thinking row); proof = s40-streaming-held.png + server-truth.ndjson" > "$out/s40-held-ui-note.txt"
    else
      remount_until "$title" "Step 5 of 8" s40-held-ui || { shot s40-held-NO-UI-PROOF; rec_stop s40; return 1; }
      sleep 1
      shot s40-streaming-held-remounted
    fi
  fi
  # mid-turn means: UI has step 5 but not step 6, and the server still has the run open
  node "$uia" find "Step 6 of 8" < "$out/ui/last.dump" >/dev/null && log "UNEXPECTED: step 6 visible while held"
  node "$kit/ctl/mockctl.mjs" release live40
  wait_server "$tid" "Live stream complete" 90 || { rec_stop s40; return 1; }
  sleep 4
  shot s40-complete
  ui_state s40-complete
  if ! wait_ui "Live stream complete" 30 s40-done >/dev/null; then
    log "UI lacks 'Live stream complete' (stale/blank thread view or uiautomator flake); remounting thread"
    remount_until "$title" "Live stream complete" s40-done || { shot s40-complete-NO-UI-PROOF; rec_stop s40; return 1; }
    sleep 1
    shot s40-complete-remounted
  fi
  server_truth s40-complete "$tid"
  rec_stop s40
  log "s40 server status held=$held_status final=$SRV_STATUS"
  [ "$held_status" = running ] && echo "$SRV_TEXT" | grep -q "Live stream complete"
}

run_s41() {
  local title="$TP approval" tid
  rm -f "$ws/NOTES.md"
  clear_gates
  next live-approval gate=g41
  rec_start s41
  tid=$(start_thread "$title" "Please write a notes file.") || { rec_stop s41; return 1; }
  log "s41 thread $tid"
  echo "$tid" > "$out/s41.threadid"
  open_thread "$title" || { rec_stop s41; return 1; }
  node "$kit/ctl/mockctl.mjs" wait-reached g41 60 || log "gate g41 not reached"
  sleep 2
  node "$kit/ctl/mockctl.mjs" release g41
  if ! wait_ui "Approval needed|Allow once" 45 s41-card >/dev/null; then
    log "approval card not in UI tree; recording server truth, then remount (BACK, reopen)"
    shot s41-card-missing
    server_truth s41-card-missing "$tid"
    open_thread "$title" || { rec_stop s41; return 1; }
    wait_ui "Approval needed|Allow once" 45 s41-card2 >/dev/null || { shot s41-card-missing2; server_truth s41-card-missing2 "$tid"; rec_stop s41; return 1; }
  fi
  sleep 2
  shot s41-approval-pending
  ui_state s41-pending
  server_truth s41-pending "$tid"
  [ -e "$ws/NOTES.md" ] && log "UNEXPECTED: NOTES.md exists before approval"
  [ "$plat" = ios ] && { ensure_operable "$title" || true; shot s41-approval-operable; }
  tap_re "^(Approve|Allow once)$" 20 s41-approve || { rec_stop s41; return 1; }
  wait_server "$tid" "Approved" 90 || { shot s41-no-resolution; rec_stop s41; return 1; }
  sleep 4
  shot s41-approval-resolved
  ui_state s41-resolved
  server_truth s41-resolved "$tid"
  rec_stop s41
  local ok=1
  [ -e "$ws/NOTES.md" ] && log "SERVER-SIDE: $ws/NOTES.md exists: $(head -c 80 "$ws/NOTES.md" | tr '\n' ' ')" || { log "NOTES.md missing"; ok=0; }
  echo "$SRV_TEXT" | grep -q "Approved" || { log "assistant text lacks Approved"; ok=0; }
  [ "$ok" = 1 ]
}

run_s42() {
  local title="$TP question" tid
  next ask
  rec_start s42
  tid=$(start_thread "$title" "I want to tune the code style.") || { rec_stop s42; return 1; }
  log "s42 thread $tid"
  echo "$tid" > "$out/s42.threadid"
  open_thread "$title" || { rec_stop s42; return 1; }
  # same as s41: a pending request that exists on first open of a thread is not rendered until the thread is remounted
  if ! wait_ui "Fill in the pending answers|^Strict" 30 s42-card >/dev/null; then
    log "question card not in UI tree on first open; remount (BACK, reopen)"
    shot s42-card-missing
    open_thread "$title" || { rec_stop s42; return 1; }
    wait_ui "Fill in the pending answers|^Strict" 45 s42-card2 >/dev/null || { shot s42-card-missing2; rec_stop s42; return 1; }
  fi
  sleep 2
  shot s42-question-pending
  ui_state s42-pending
  server_truth s42-pending "$tid"
  [ "$plat" = ios ] && { ensure_operable "$title" || true; }
  tap_re "^Strict" 15 s42-option || { tap_re "Fill in the pending answers" 10 s42-expand && tap_re "^Strict" 15 s42-option2; } || { rec_stop s42; return 1; }
  sleep 1
  shot s42-question-selected
  tap_re "^Submit answers$" 15 s42-submit || { rec_stop s42; return 1; }
  wait_ui "Worked for|Strict \(Recommended\)$" 90 s42-answered >/dev/null || { rec_stop s42; return 1; }
  sleep 2
  shot s42-question-answered
  ui_state s42-answered
  server_truth s42-answered "$tid"
  rec_stop s42
  echo "$SRV_TEXT" | grep -q "going with"
}

shot 00-before
for P in $providers; do
  use_provider "$P"
  log "##### provider flavor: $P (out=$out)"
  [ "$P" != grok ] && shot "00-before-$P"
  for s in $scenarios; do
    log "=== $s ($P) ==="
    PROV_BAD=0
    if "run_$s" && [ "$PROV_BAD" = 0 ]; then record_result "$(rlabel "$s")" ok; else record_result "$(rlabel "$s")" fail; shot "$s-FAILED"; ui_state "$s-failed"; fi
  done
done
out=$live_root
log "results: ${results[*]}"
printf '%s\n' "${results[@]}" > "$out/results.txt"
cp "$MOCK_CONTROL_DIR/probes.log" "$out/probes.log" 2>/dev/null
for r in "${results[@]}"; do case "$r" in *=fail) exit 1;; esac; done
exit 0
