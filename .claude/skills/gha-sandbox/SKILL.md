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
- Desktop mock: `gh workflow run desktop-linux.yml --repo kaovilai/gha-sandbox -f mock=true -f scenarios=desktop` (web drivers inside real Electron via CDP + xdotool, x11grab video; see mockkit/README.md Desktop). Packs/ids: s03,s06,s08,dk01-dk03.
- Desktop: run built app (`build:desktop` + `start:desktop`); dev mode opens DevTools. Onboarding: Enter x5 then click (832,577) "Do not import projects".
- Mobile: upstream `scripts/mobile-showcase.ts` (seeded, keyless). Our patches to throwaway checkout: scene timeouts, loopback Metro host, exact-bundle warm (`patch-showcase-warm.py`), caching manifest proxy `scripts/metro-manifest-proxy.mjs` (dev launcher 10 s timeout, HEAD probe).
- Mobile live mock threads: `-f live=true` on `android-app.yml` (iOS verified S40-S42) → `scripts/mobile-live.sh` seeds mockkit into showcase server, starts threads via `bin.ts thread start`, taps app (uiautomator / AXe), S40 stream, S41 approve, S42 question. Evidence `live__*.png|gif|mp4`. Detail `mockkit/README.md` "Mobile".
- iOS live pairing fixed: fresh credential per attempt (`ios-pairing-server.mjs` + `patch-showcase-ios-pairing.py`), mockkit README "iOS live pairing". Non-live iOS still upstream pairing (can flake). Failed mobile run → evidence `diag__t*.png`. Thread buttons disabled ("cannot respond…") = session scopes not loaded → remount (`ensure_operable`).
- Keyless real-looking turns: mockkit (web, profile `t3code-mock`). `-f profile=t3code-mock -f sides=after -f scenarios=web|wide|smoke|s07|s03,s17` (packs `mockkit/packs.json`: web 11, wide 14, desktop 6; `scenario` path input still ok). One fresh T3 + workspace per scenario (no cross-scenario state). Drivers route hidden via `mockctl next <id>` queue, no `[mock:` in UI. Detail `mockkit/README.md`.
- mockkit Codex flavor zero-dep `codex app-server`+`exec` mock (`mockkit/adapters/codex.mjs`, launcher `mock-cli.sh` MOCK_CLI_FLAVOR=codex) → T3 shows Codex READY (OpenAI icon, GPT-6-Astra), keyless. CI: `scenarios=codex` (17 drivers) | `s03@codex,s08@codex`; evidence `codex-<driver>-*.png`. Seed `MOCK_PROVIDER=grok|codex|both`. Approvals only when Supervised (Codex `never` never asks). Detail README "Codex adapter".
- mockkit tighten drivers assert real DOM/disk state (`expect*` in lib/ui.mjs; `getByText` pierces shadow DOM, `body.innerText` no). Runner hostname/paths masked in DOM via lib/mask.mjs (`MASK-LEAK` log = leak). S01 seeds mock Codex (wizard offers only Codex/Claude). S28 = own `background-task` scenario (persistent Monitor → banner "Running: ..."+Stop). S37 tree rows = `[data-type=item][role=treeitem][data-item-path]:not([data-item-parked])` (shadow). S24 proof = mock log `textgen`. README "Evidence hardening".
- mockkit Claude flavor zero-dep `claude` stream-json mock (`mockkit/adapters/claude.mjs`; launcher `mock-cli.sh` MOCK_CLI_FLAVOR=claude or argv `--output-format`) = what Claude Agent SDK spawns → T3 shows Claude READY (starburst icon, Claude Fable/Opus/Sonnet/Haiku 5.x, "Claude Max"), keyless. CI: `scenarios=claude` (20 drivers) | `s03@claude,s22@claude`; evidence `claude-<driver>-*.png`. Seed `MOCK_PROVIDER=claude|all|claude+grok`. Approvals only in Supervised (bypass never asks); AskUserQuestion/ExitPlanMode always ask; plan toggle needs client setting planModeEnabled (S11b sets it). T3 renders Claude text per finished block, not per word. Extra drivers: s22 resume (kills CLI, `--resume=`), s23 slash cmds. Detail README "Claude adapter".
- mockkit codex-gaps (track-codex-gaps): `scenarios=codex-extra` (s50-s59) → MCP elicitation, perm grant, subagents (+child approval), `/goal`, thread revert ("Edit from here"), chatgpt acct (`meta.env` MOCK_CODEX_ACCOUNT=chatgpt, `/usage-limits`, reset credit), web search, retry, MCP app iframe. New IR ops elicit/grant/subagent/goal/web/retry/mcpApp (ACP degrades). Goal scenarios need `hold=` (race w/ `goal/set active`). T3 refuses "Revert files too" in shared workspace (T3, not mock). Not covered: bg terminals, dynamicToolCall, async questions. README "Codex gaps closed".
- Codex flavor everywhere: `-f mock_provider=grok|codex|both` on `desktop-linux.yml` (mock=true; pack `desktop-codex`; files `codex-<driver>-*`), `android-app.yml`/`ios-app.yml` (live=true; evidence `live__codex__*`, thread titles "Codex ..."). Env `MOCK_PROVIDER` → `seed/settings.mjs`, `scripts/mobile-live.sh`. Detail README "Codex everywhere".
- mockkit claude-gaps (track2-claude-gaps): `scenarios=claude-extra` (s60-s71, claude-only drivers) → subagents (Agent tool, child frames `parent_tool_use_id`), bg Bash (`run_in_background`, roster, wake turn after result) + TaskOutput/TaskStop, Monitor, hooks (T3 ignores `hook_*`: not rendered), MCP rows (`mcp__srv__tool`+`tool_use_meta`), skills (`<ws>/.claude/skills/<n>/SKILL.md`, `$n` picker → `/n args`), `/compact` + auto, rewind (`--resume-session-at`), image in/out, WebSearch/WebFetch, api_retry/notice, `/goal`. New IR ops skill/hook/compact/notice/bgControl (ACP/Codex degrade). Hold gates pin running states. Not built: bg subagents, nested, fork, ToolSearch. README "Claude gaps closed".
- mockkit verified on main (2026-10-23, merged head): web 11, wide 14, codex 17+codex-extra 10, claude 20 (RESULT ok); desktop mock 6 x grok+codex (`-f mock_provider=both`); android live + iOS live S40-S42 x grok+codex (run 40029083323 iOS, 40032925659 android). Flavor input `mock_provider=grok|codex|both` on desktop/android/ios workflows. Not built: Claude on desktop/mobile, Claude subagents/hooks/MCP. `RESULT ok` ≠ proof: view the PNG (README "Known evidence limits").

## Caching

Save-on-miss, exact keys. Mobile keys = native-inputs hash computed ONCE (`id: native`) before build; build mutates hashed files. Prune `gh cache list` / `gh cache delete`, keep <10 GB (AVD 3.4 GB).

## Debug run

- Failed step: `gh run view <id> --json jobs --jq '.jobs[].steps[]|select(.conclusion=="failure").name'`; `gh run view <id> --log-failed`.
- Live log: `gh api --allow-escape-sequences repos/kaovilai/gha-sandbox/actions/jobs/<jobid>/logs`.
- Stuck: `gh run cancel <id>`; wait for status completed before reading logs.
- Mobile run artifacts include `diag/` screenshots every 20 s + `proxy.log`.

Portable tools: Bash=exec_command|run_command|bash; Read=view_file|read_file
