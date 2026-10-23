---
name: gha-sandbox
description: "Use kaovilai/gha-sandbox: free GitHub Actions VMs (public repo) to repro PRs + record screenshots/videos on web, Linux desktop (Electron), Android emulator, iOS simulator, before/after, no local RAM. Use when user wants UI repro/evidence/recording for a t3code or other project PR, says 'record this', 'before/after screenshots', 'screenshot from Linux VM', 'android/ios emulator capture', 'sandbox', 'evidence branch', 'add a target profile', or a capture run fails/stalls/is slow."
---

# gha-sandbox

Public repo = free Actions minutes. Fresh runner per run, not long-lived. Evidence → orphan branch `evidence` of THIS repo, never target repo (t3code CONTRIBUTING bans committing PR-only evidence).

## Pick workflow

| need | workflow | cmd |
|---|---|---|
| web before/after | `sandbox.yml` | `scripts/sbx run <PR\|ref> [--profile p] [--repo o/n] [--sides both\|before\|after] [--shell]` |
| Linux Electron desktop | `desktop-linux.yml` | `gh workflow run desktop-linux.yml --repo kaovilai/gha-sandbox -f ref=pull/<N>/head` |
| Android app | `android-app.yml` | same, `-f ref=` |
| iOS app | `ios-app.yml` | same, optional `-f keep_running=true` |
| emulator probe | `emulators.yml` | `-f platforms=android\|ios\|both` |
| re-publish old run | `publish-run.yml` | `-f run_id=<id> -f artifact=out-<x> -f label=<x>` |

Inputs: `repo` (default `pingdotgg/t3code`), `ref`/`head_ref` = branch, sha, or `pull/<N>/head`.

## Flow

1. Dispatch `gh workflow run X.yml --repo kaovilai/gha-sandbox -f ...`.
2. `gh run watch <id> --exit-status`. Warm times: web ~5-10 min, desktop 2.5, iOS 5, Android 12. Cold: desktop 9, iOS 16.5, Android 33.
3. Evidence: `git fetch origin evidence`; dirs `<run-id>/` (web), `<run-id>-desktop`, `-android-app`, `-ios-app`. Files: `after-*.png`, `before-*.png`, `side-by-side-*.png`, `*.gif`, `*.mp4`.
4. Read PNG yourself. Confirm real UI state, not onboarding/blank/error banner, before claiming success.
5. PR md: PNG/GIF inline `![](https://raw.githubusercontent.com/kaovilai/gha-sandbox/evidence/<dir>/<file>)`; MP4 link `https://github.com/kaovilai/gha-sandbox/blob/evidence/<dir>/<file>?raw=true`. Run summary prints paste-ready md.

## Don't

- `gh run download` big artifacts repeatedly → account egress limit (HTTP 503). Use evidence branch + `gh run view <id> --log`.
- `git add -A` (agent worktrees land in `.claude/`). Add explicit paths.
- bare `apt-get` on runners → stalls 10+ min. Use `scripts/apt-install.sh`. ffmpeg: `FedericoCarboni/setup-ffmpeg` (no arm64 macOS), `playwright install` without `--with-deps`.
- floating `voidzero-dev/setup-vp@v1` (frozen). Exact tag.
- `pull_request_target`, secrets in repo. Target code untrusted.
- gh write blocked by hook → use `mcp__github__*` tool.

## Profiles (web)

`targets/<name>/`: `profile.env` (`USES_VP`, `NODE_VERSION`), `setup.sh` (install, cwd=target), `start.sh` (start app; log `$APP_LOG`; URL → `$APP_URL_FILE`), `scenario.mjs` (`run()` from `lib.mjs`: `shot(name)`, auto video, opens `$APP_URL`).
Verified: `t3code`, `static`. Add: `cp -r targets/static targets/<new>`, edit `start.sh` + `scenario.mjs`, test:
`gh workflow run sandbox.yml --repo kaovilai/gha-sandbox -f profile=<new> -f repo=o/n -f base_ref=main -f head_ref=main -f sides=after`
Scenario tips: mask nondeterministic text (runner hostname), dismiss banners, no relative-time asserts.

## t3code specifics

- Web: pairs via `pairingUrl:` log line. Provider banner "Codex provider status" (no CLI on runner) → scenario dismisses.
- Desktop mock: `gh workflow run desktop-linux.yml --repo kaovilai/gha-sandbox --ref <br> -f mock=true -f scenarios=desktop` (web drivers inside real Electron via CDP + xdotool, x11grab video; see mockkit/README.md Desktop). Packs/ids: s03,s06,s08,dk01-dk03.
- Desktop: run built app (`build:desktop` + `start:desktop`); dev mode opens DevTools. Onboarding: Enter x5 then click (832,577) "Do not import projects".
- Mobile: upstream `scripts/mobile-showcase.ts` (seeded, keyless). Our patches to throwaway checkout: scene timeouts, loopback Metro host, exact-bundle warm (`patch-showcase-warm.py`), caching manifest proxy `scripts/metro-manifest-proxy.mjs` (dev launcher 10 s timeout, HEAD probe).
- iOS pairing intermittently fails ("No environments connected"); see README.
- Keyless real-looking turns: mockkit (web, profile `t3code-mock`). `-f profile=t3code-mock -f sides=after -f scenarios=web|s07|s03,s17` (packs `mockkit/packs.json`; `scenario` path input still ok). One fresh T3 + workspace per scenario (no cross-scenario state). Drivers route hidden via `mockctl next <id>` queue, no `[mock:` in UI. Detail `mockkit/README.md`.

## Caching

Save-on-miss, exact keys. Mobile keys = native-inputs hash computed ONCE (`id: native`) before build; build mutates hashed files. Prune `gh cache list` / `gh cache delete`, keep <10 GB (AVD 3.4 GB).

## Debug run

- Failed step: `gh run view <id> --json jobs --jq '.jobs[].steps[]|select(.conclusion=="failure").name'`; `gh run view <id> --log-failed`.
- Live log: `gh api --allow-escape-sequences repos/kaovilai/gha-sandbox/actions/jobs/<jobid>/logs`.
- Stuck: `gh run cancel <id>`; wait for status completed before reading logs.
- Mobile run artifacts include `diag/` screenshots every 20 s + `proxy.log`.

Portable tools: Bash=exec_command|run_command|bash; Read=view_file|read_file
