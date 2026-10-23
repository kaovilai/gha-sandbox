# mockkit: keyless T3 Code

Exercise (nearly) every aspect of t3code without an AI provider key, and record it on CI.

```
Playwright driver ──UI──▶ t3code (vp run dev) ──spawns──▶ mockkit/bin/mock-cli.sh (fake `grok`)
mockkit/scenarios-ui/*.mjs                                   │ agent stdio
                                                             ▼
                                              mockkit/bin/t3-mock-acp.mjs  (zero-dep ACP, NDJSON JSON-RPC)
                                                             │ runSteps()
                                                             ▼
                                              mockkit/scenarios/*.mjs   (provider-neutral IR)
```

T3 spawns provider processes from `settings.json` `providerInstances`, so the mock lives entirely
server-side: one seeded instance (`grok`, `binaryPath` = `mockkit/bin/mock-cli.sh`) makes the **Grok**
provider show READY ("Authenticated", model "Mock Build"). Codex and Claude instances are written
`enabled:false` (they can never work keyless; this also removes the "Could not start Codex CLI" banner
and makes the mock the default model). `MOCK_KEEP_OTHER_PROVIDERS=1` keeps them.

## Layout

| path | role |
| --- | --- |
| `lib/ir.mjs` | scenario IR (`S.say/think/tool/read/fsWrite/sh/permission/ask/plan/error/hold/sleep`) + `runSteps()` |
| `lib/pace.mjs` | deterministic pacing (`MOCK_PACE=fast\|real\|slow`, seeded PRNG `MOCK_SEED`) |
| `lib/select.mjs` | `[mock:<id> k=v]` tag parser (after the last `<user_request>`), text-gen detection |
| `lib/hold.mjs`, `ctl/mockctl.mjs` | `{hold:name}` gates released from outside (`release`, `wait-reached`); `next <id>` = hidden routing |
| `lib/queue.mjs` | per-cwd FIFO "next scenario" queue read by the agent |
| `lib/boot.mjs` | boot/stop one isolated T3 dev instance (CI) |
| `packs.json` | scenario packs for `SCENARIOS` (`web`, `smoke`, `explore`, `all`) |
| `lib/log.mjs` | NDJSON log of every frame in/out and every step to `$MOCK_LOG` |
| `adapters/acp.mjs` | ACP agent: initialize, authenticate, session/new\|load\|resume\|close, set_model, set_config_option, prompt, cancel, request_permission, `_x.ai/ask_user_question` |
| `bin/t3-mock-acp.mjs`, `bin/mock-cli.sh` | entrypoint; fake grok launcher (`--version`, `models`, `inspect --json`, `agent stdio`); also routes the Codex flavor (below) |
| `adapters/codex.mjs`, `bin/t3-mock-codex.mjs`, `lib/textgen.mjs` | Codex app-server + `exec` text generation on the same IR (section "Codex adapter") |
| `adapters/claude.mjs`, `bin/t3-mock-claude.mjs` | Claude stream-json CLI (Agent SDK) + `-p` text generation on the same IR (section "Claude adapter"); `test/claude.test.mjs` |
| `seed/settings.mjs`, `seed/workspace.sh` | write `settings.json` (+ `client-settings.json`) and create the demo workspace repo |
| `scenarios/*.mjs` | mock scripts: echo, markdown-stream, think, tool-read, edit-file-diff, approval-allow, error-turn, shell, slow, ask, plan |
| `scenarios-ui/<id>.mjs` | Playwright drivers (`export default async ({page, shot, env}) => ...`) |
| `test/acp.test.mjs` | `node --test mockkit/test`, no T3 needed (~10 s; CI: `mockkit-test.yml`) |

CI: `targets/t3code-mock/` (profile.env/setup.sh copied from `targets/t3code`). `start.sh` only validates the toolchain;
`scenario.mjs` boots **one isolated T3 instance per scenario** (`lib/boot.mjs`: fresh `--home-dir` = fresh DB/settings,
fresh workspace repo `<tmp>/mockkit-run/<id>/ws/demo-app`, fresh control dir + mock log, `T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false`
so there is no bootstrap project/"New thread"), pairs once, runs the driver, tears the process group down. So every shot shows
only its own scenario: one project, its own threads, `Changes +0 -0` until the scenario edits files.

```sh
# web pack, or any subset (comma ids, short prefix, pack name from mockkit/packs.json: web | smoke | explore | all)
gh workflow run sandbox.yml --ref <branch> -f profile=t3code-mock -f repo=pingdotgg/t3code \
  -f base_ref=main -f head_ref=main -f sides=after -f scenarios=web          # or s07  /  s03,s17
```

`sandbox.yml` input `scenarios` is exported as env `SCENARIOS` to the scenario step (the older `scenario` path input still works;
`-f scenario=targets/t3code-mock/set-all.mjs` = the web pack).

## Scenario coverage (web, `SCENARIOS=wide` for the second wave; `web` = first wave)

Status = what a CI run showed (screenshots viewed). Evidence lives under `evidence/<run-id>/` of this repo.

| id | what it shows | status (run) |
| --- | --- | --- |
| s01-first-run-wizard | clean state, `/` redirects to the Connect / Agents / Projects setup wizard (`meta.firstRun`) | ok: wizard walked through all 3 steps (the wizard only offers Codex/Claude, so the driver seeds the mock CODEX agent: card shows Ready), lands in the app, stays gone after reload (see "Evidence hardening") |
| s09-approval-deny | Supervised mode, shell approval card, Decline, agent acknowledges (`approval-deny`) | ok (39938011625) |
| s11b-proposed-plan | xAI `exit_plan_mode` extension request becomes a ProposedPlanCard + Plan actions menu (`exit-plan`, IR step `exitPlan`) | ok; no Plan-mode toggle exists for Grok, card renders in build mode (39940420110) |
| s12-todo-entries | six-item Tasks panel advancing pending / in progress / completed (`todo`) | ok (39938011625) |
| s14-usage-limit | grok-driver instance running the UPSTREAM `acp-mock-agent.ts` with `T3_ACP_EMIT_XAI_RATE_LIMIT_THEN_HANG=1` -> "Usage limit reached" banner + sidebar "Limited" | ok (39942756494). Through the `acpRegistry` driver the same flag is NOT mapped (verified negative, 39940420110) |
| s16-queue-steer | held turn + 2 queued messages, Queued list with Steer / edit / remove, steer, release | ok (39938011625) |
| s18-provider-status-matrix | Settings > Providers cards: ready / signed out / outdated (warning) / broken CLI / binary missing | ok (39938011625) |
| s20-model-picker-switch | picker with two provider instances, switch mid-thread -> "Context handoff Mock Build -> Mock Fast" row | ok; the reply after the switch is a natural answer (the T3 handoff preamble is stripped, asserted absent) |
| s24-git-commit-push | commit dialog, commit message generated by the text-gen stub, Push to a local bare remote (verified with `git ls-remote`) | ok; commit subject proven from the mock `textgen` log entry (see "Evidence hardening") |
| s28-background-task | own `background-task` scenario (xAI persistent Monitor: `task_backgrounded` + `task_completed`) | ok: thread Done, composer banner "Running: Start monitor: Watch the dev server" + Stop; completion report -> `Monitor "..." finished` row + wake reply; banner cleared with its Stop button |
| s31-sidebar-thread-actions | right-click menu: pin, settle, snooze submenu + snooze, rename, archive with undo notice | ok (39941468815) |
| s33-command-palette-tour | Ctrl+K command list, Go to file, Search project contents | ok (39938011625) |
| s34-settings-tour | Settings routes (source-control is a skeleton-load shot, licenses highlights General), appearance cycle light/dark via shortcut | ok: every section asserted (breadcrumb + page-only text), settings search, Light/Dark mode tiles (`aria-pressed` + `html.dark`), cycle shortcut, Ocean theme card (`data-theme-id`, preview-circle `aria-pressed`) |
| s37-files-browser | right-panel Files tree + source / markdown (source view) / csv table / svg image previews | ok: rows clicked in the tree (shadow DOM, by `data-item-path`), markdown shown as source AND as rendered preview, csv table, svg `<img>`, tree search, Ctrl+P picker |

Helpers: `lib/ui-extra.mjs` (`seedInstances` = extra grok-driver provider instances via the hot-reloaded settings.json, `seedUpstreamGrok` /
`pickInstance` = upstream agent behind the grok driver, `gotoPath`, `must`). `MOCK_UPSTREAM_AGENT=<acp-mock-agent.ts>` makes `mock-cli.sh agent stdio`
exec the upstream mock (node `--experimental-strip-types`) so `T3_ACP_*` flags drive xAI-extension behaviour; it needs the target checkout's node_modules.
`scenario.mjs` exports `MOCKKIT_STATE` (state dir) and `MOCKKIT_ROOT` to drivers; a driver may `export const meta = { firstRun: true }` to skip the onboarding seed.

## Selecting a scenario

**Hidden routing (default for drivers).** The driver queues the next scenario for the session's cwd and types a natural prompt:
`mockctl.mjs next slow hold=rec --cwd <ws>` (or `nextScenario(env, "slow", {hold:"rec"})` / `ask(page, env, id, prompt, args)` in
`lib/ui.mjs`). The agent pops one entry per user turn from `$MOCK_CONTROL_DIR/queue/<sha1(realpath cwd)>.ndjson` (`_any` = any
session), FIFO, per cwd. Nothing selector-like is ever typed, so no `[mock:` text appears in any recording.

**Prefix fallback (unit tests / manual use).** Put `[mock:<id>]` (optional `k=v` args) anywhere in the user message:
`[mock:slow hold=rec] go`. A tag wins and does not consume the queue. No tag and empty queue runs the
`echo` scenario (replies with the turn number and quotes the previous prompt). Text-generation sessions
(thread titles, commit/PR/branch text; same provider) are detected by `clientInfo.name == "t3-code-git-text"`
or a "Return JSON ..." preamble and answered with valid JSON **without** running a scenario; thread titles
become the scenario's `title`, so the sidebar reads "Failing turn", "Approval request", ... instead of the tag.

## Add a scenario

1. `mockkit/scenarios/<id>.mjs`: `export default { id, title, steps: (ctx) => [S.say(...), ...] }`.
   `ctx` has `turn`, `args`, `text`, `history`, `cwd`, `env`. Registry is auto-loaded.
2. Add a unit test in `test/acp.test.mjs` (feed frames, assert replies).
3. `mockkit/scenarios-ui/s<NN>-<name>.mjs`: use `startSession(page, env)` (adds the demo project, opens a new thread on
   the mock model), `sendPrompt`, then wait on text and `shot("name")`. Files come out as `<id>-<name>.png` and
   `<id>.webm` (flat: the publish job only globs the top level).
4. Add the id to a pack in `mockkit/packs.json` (or pass `scenarios=<id>`; prefixes like `s07` work).

## Env vars

`MOCK_LOG` (NDJSON), `MOCK_PACE` (fast/real/slow), `MOCK_SEED`, `MOCK_DEFAULT_SCENARIO`, `MOCK_CONTROL_DIR`,
`MOCK_HOLD_TIMEOUT_MS`, `MOCK_CLI_MODE` (ready/unauth/old/broken/missing, launcher probe output),
`MOCK_KEEP_OTHER_PROVIDERS`, `MOCK_NODE`, `MOCK_PROVIDER` (grok|codex|claude|both|all|a+b), `MOCK_CLI_FLAVOR` (codex|claude), `MOCK_CODEX_ACCOUNT` (apiKey|chatgpt). Baseline no-cloud env set by `lib/boot.mjs`: `T3CODE_TELEMETRY_ENABLED=false
T3CODE_OTEL_SDK_DISABLED=true T3CODE_NO_BROWSER=1 T3CODE_DISABLE_AUTO_UPDATE=true`.

## Findings (verified in CI)

* State dir under `vp run dev --home-dir H` is `H/userdata` (discovered via `environment-id`; `start.sh` still discovers at runtime).
* `settings.json` is hot-reloaded: seeding after boot makes Grok READY within seconds, no restart.
* The pairing token is **one-time**: authenticate once and reuse `storageState` for later scenarios (`scenario.mjs` does).
* Web onboarding is skipped with localStorage `t3code:client-settings:v1 = {onboardingCompletedAt}` (`skipOnboarding`).
* `T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false` (read by dev-runner) removes the server's cwd bootstrap project + Codex "New thread".
* Readiness is polled, not slept: the launcher appends every probe to `$MOCK_CONTROL_DIR/probes.log` (boot waits for `models`), the
  shell is asserted by the sidebar "Add project" button (fails loudly on a bad/used pairing token), and the composer polls until
  the model picker reads "Mock ...".
* Real writes made by the mock in the session cwd ARE seen by the Changes panel / diff (header `+5 -1`, per-file diff, "N changed files" card).
* The composer defaults to "Full access", which auto-approves: approval scenarios must switch to "Supervised" first.
* Selecting an option in the ask-user-question panel submits immediately.
* The `<user_request>` wrapper is not needed for web turns in the cases seen; the parser handles both.

## Desktop (Electron under Xvfb)

`desktop-linux.yml -f mock=true -f scenarios=desktop` (packs.json `desktop`; ids/prefixes also work: `s03,dk02`). Flow:
`scripts/desktop-capture.sh` (MOCK=true) builds the target once, then `targets/t3code-mock/desktop-scenario.mjs` boots ONE isolated BUILT
Electron app per scenario (`lib/desktop.mjs`, launcher `bin/desktop-electron.mjs` = start-electron.mjs + extra flags):

* fresh `T3CODE_HOME` (state dir = `$T3CODE_HOME/userdata`, non-dev), fresh `XDG_CONFIG_HOME` (Chromium profile), fresh workspace + control dir;
  `seed/settings.mjs` writes `settings.json` (mock Grok READY) and `client-settings.json` (skips onboarding, desktop reads it from the state dir, not localStorage);
* flags `--remote-debugging-port=9222 --password-store=basic` (before the script path, as dev-electron.mjs does); `T3CODE_DISABLE_AUTO_UPDATE=true`;
  `VITE_DEV_SERVER_URL` must stay unset (it flips to dev mode: DevTools window, `dev` state dir);
* Playwright `chromium.connectOverCDP` attaches to the renderer (page URL is `t3code://app/`, not http); the SAME `scenarios-ui` drivers run unchanged
  (`page.viewportSize()` is stubbed from `innerWidth/innerHeight`, CDP has no emulated viewport);
* `shot(name)` = `import -window root` (real X11 desktop: titleBarOverlay controls, native popups); shots with a `clip` option stay Playwright element crops;
* video = ffmpeg x11grab of the display per scenario (`<id>.mp4`, 15 fps); `native` helper (xdotool key/click, window tree) is passed to desktop-only drivers in `scenarios-desktop/` (ids `dk*`).

Isolation gotcha: the backend (`apps/server/dist/bin.mjs`) runs in its own process group and survives a killed main process, keeping port 3773
and making the next app's CDP port bind fail ("Address already in use"). `desktop.mjs` stop() pkills stragglers and waits for the CDP port to free.
`mock` mode installs a smaller apt set + static ffmpeg: the full apt set (apt ffmpeg) stalled the runner mirror for 20+ min twice (runs 39943850273).

Cannot render / not available under Xvfb (observed or by construction):

* Alt-revealed native menu bar (autoHideMenuBar + titleBarStyle hidden): pressing Alt shows NO menu bar (run 39943262981 dk01). Menu accelerators still work
  (`ctrl+comma` -> Settings via the native menu, verified), so menu actions are drivable but the menu itself is not shown.
* No window manager: no WM frame, snapping, alt-tab, window decorations beyond Electron's own titleBarOverlay (min/max/close drawn by Chromium).
* Native folder-pick dialog (GTK portal / xdg-desktop-portal: no dbus session, "Failed to connect to the bus" in the log): not exercised; the drivers add projects by typing a path in the command palette.
* No system tray, notifications daemon, Dock/menu-bar-extra, OS secure storage (basic_text via `--password-store=basic`), GPU (software GL; "dri3 extension not supported"),
  auto-update (disabled), `t3code://` URL-handler registration / xdg-open, drag and drop from a file manager, IME.
* Right-click gives Chromium's native Cut/Copy/Paste/Select All popup (visible in root captures only); the sidebar thread row has no thread-specific native menu here.

## Mobile: live mock threads (S40-S42)

`android-app.yml -f live=true` (and `ios-app.yml -f live=true`, best effort) run the upstream showcase with `--keep-running`, then
`scripts/mobile-live.sh <android|ios> <showcaseRoot>` drives the already-paired app against the showcase's own server
(`<root>/environments/moonbase-terminal`, project `t3code`). Default path (`live=false`) is untouched.

1. Hot-seed `seed/settings.mjs` into `<baseDir>/userdata` with `MOCK_KEEP_OTHER_PROVIDERS=1` and `MOCK_DEFAULT_RUNTIME_MODE=approval-required`
   (CLI-started threads take their mode from the environment default, so approvals are not auto-accepted).
2. Start threads with the server CLI: `node apps/server/src/bin.ts thread start --base-dir <baseDir> --title T --provider grok --model grok-build --json t3code "<prompt>"`
   (MCP `t3_thread_launch`); read truth with `thread show --json <id>` (`.thread.status`, `.pendingRequestCount`, assistant text).
3. Hidden routing + gates: `mockctl next live-stream gate=g40 hold=live40 --cwd <workspace>`; the scenario waits on `gate` so the thread can be
   opened in the app first, then `mockctl release g40`.
4. UI state: `adb shell uiautomator dump` (Android) / `axe describe-ui` (iOS) parsed by `scripts/uia.mjs`; taps by label bounds.
   Screenshots + `screenrecord`/`simctl recordVideo` clips land in `out/<platform>-app/live/`.
5. `scripts/patch-showcase-live.py` (throwaway checkout, JS only): the showcase coordinator re-navigates to its fixture route whenever the
   route's scene differs from the requested scene; the patch navigates once per scene request so manual taps/BACK stick.

| id | scenario | proof |
| --- | --- | --- |
| S40 | `live-stream`: gate, steps 1-5, hold, steps 6-8 | timed shots (3 steps, 5 steps, held with "Working" + stop button, complete 8 steps), server status `running` then `completed` |
| S41 | `live-approval`: gate then approval, tap **Approve** | card shot, resolved shot (only "Worked for ..." and +3 -0 are visible; the "Approved: NOTES.md was written" text is NOT in the shot, so resolution is proven by server truth: `NOTES.md` exists in the workspace, pending 1 then 0) |
| S42 | `ask`: tap option, **Submit answers** | card, option selected, answered, server `pending` 1 then 0 |

Findings (Android, CI): (a) uiautomator cannot reach an idle tree while text streams in and then leaves the previous dump on disk;
`dump()` deletes the file first, retries, and streaming growth is proven by screenshots + server text instead; (b) intermittently (2 of 4 Android runs), a pending approval or
question that exists when a thread is opened is not rendered until the thread is remounted (BACK, reopen); the driver remounts once if the
card is absent after the first wait;
(c) approval buttons are `Cancel`, `Decline`, `Allow all edits this session`, `Approve` (not "Allow once"); (d) assistant markdown text
nodes are sometimes absent from the accessibility tree, so final-state checks also read the server.

## Codex adapter

A second protocol flavor on the same scenario IR: T3's `codex` driver shows the Codex-branded provider (OpenAI icon, "GPT-6-Astra" model picker,
reasoning-effort picker, Settings > Providers card "Authenticated · OpenAI API Key"), fully keyless.

```
T3 codex driver ──spawns──▶ <binaryPath> app-server      = mockkit/bin/mock-cli.sh (MOCK_CLI_FLAVOR=codex, or argv app-server|exec|mcp)
                                   │                              └─▶ bin/t3-mock-codex.mjs ──▶ adapters/codex.mjs (newline-delimited JSON-RPC)
text generation ──spawns──▶ <binaryPath> exec ... --output-schema S --output-last-message F -    (also `mcp list --json`, `--version`)
```

Frame shapes come from the upstream recorded transcripts (`orchestration-v2/testkit/fixtures/*/codex_transcript.ndjson`) and the generated schema
(`packages/effect-codex-app-server/src/_generated/schema.gen.ts`); `setupMode: "managed"` is never set (it downloads the real CLI).

* **Provider selection.** `MOCK_PROVIDER=grok|codex|both` (read by `seed/settings.mjs`; default `grok` = unchanged behaviour). `codex` writes
  `providerInstances.codex` enabled (`config.binaryPath` = the launcher, env `MOCK_CLI_FLAVOR=codex`), disables grok/claude, and points
  `textGenerationModelSelection` at `codex`/`gpt-6-luna`. `both` keeps Grok READY too. `MOCK_CLI_MODE=unauth|old|broken|missing` varies the probe;
  `MOCK_CODEX_ACCOUNT=chatgpt` switches the account from `apiKey` (default) to a ChatGPT Plus account (the mock then writes `CODEX_HOME/models_cache.json`; not exercised in CI).
* **Driver selection in CI.** `scenarios=codex` (pack, 17 drivers) or `s03@codex,s08@codex` (`@codex` suffix per token) or env `MOCK_PROVIDER=codex`. Codex runs
  are named `codex-<driver>` (`after-codex-s03-markdown-stream-done.png`) so they sit next to Grok runs. A driver may export `meta.seed = { codex: "both" }`
  to seed more providers than it runs against (s20). Drivers read `env.MOCKKIT_PROVIDER` (`providerOf(env)` in `lib/ui.mjs`); `startSession` picks the Codex model.
* **Probe.** `initialize` (userAgent `t3code_desktop/0.159.0 ...`, >= recommended so no compatibility banner; a second `initialize` answers -32600 "Already initialized"
  like codex), `account/read` -> `{type:"apiKey"}` (a `chatgpt` account makes T3 wait for `models_cache.json`), `skills/list`, `model/list` (gpt-6-astra default, gpt-6-luna,
  gpt-5.6-sol; low/medium/high reasoning), `config/read`, `account/rateLimits/read`.
* **Turns.** `thread/start|resume|read|fork|turns/list|compact/start|unsubscribe`, `turn/start|interrupt|steer`. Thread state (turn count, history) is persisted under
  `$MOCK_CONTROL_DIR/codex-threads/` so `thread/resume` after a respawn keeps counting. IR mapping: `say` -> `agentMessage` + deltas, `think` -> `reasoning` summary deltas,
  `sh` -> `commandExecution` (REAL `sh -c`, stdout via `outputDelta`, exit code), `read` -> `commandExecution` with a `read` command action, `fsWrite` -> `fileChange`
  (REAL write; add = content, update = single-hunk unified diff) so the Changes panel works, generic `tool` -> `mcpToolCall`, `plan` -> `turn/plan/updated`,
  `exitPlan` -> `plan` item + deltas, `permission` -> `item/fileChange|commandExecution/requestApproval` (accept/acceptForSession -> run, decline -> `declined` item +
  `onReject`, cancel -> interrupted turn), `ask` -> `item/tool/requestUserInput`, `error` -> `error` notification + failed turn (`kind:"usage_limit"` ->
  `usageLimitExceeded` after an `account/rateLimits/updated` with a 100% window), `hold` gates and the hidden `mockctl next` queue work unchanged.
  `thread/tokenUsage/updated` follows each turn (context window 258400; queue/tag arg `tokens=<n>` forces the input size, used by S21 to fill the meter).
* **Approvals follow Codex semantics:** with `approvalPolicy: "never"` (T3 "Full access") the mock never asks and the action just runs; approval drivers switch to "Supervised".
* **Text generation.** `exec` reads the prompt from stdin and writes JSON for the keys named in the `--output-schema` file to `--output-last-message` (shared `lib/textgen.mjs`).
  S24 shows the commit subject "Update files via mock agent" coming from it. Any other request gets JSON-RPC -32601 instead of hanging.
* **Limits (honest).** Model names look like real Codex models (`gpt-6-astra`...) but every answer is scripted; the picker shows "Legacy models" for gpt-5.6-sol (T3 grouping).
  No `item/permissions/requestApproval`, MCP elicitation, subagent (`collabAgentToolCall`) or goal frames are produced; `thread/goal/*` just answers empty and
  `thread/revert` is unhandled (-32601). `thread/compact/start` runs a bare `contextCompaction` turn. Agent messages are all `phase:"final_answer"` (no `commentary` phase).
  The file-change approval card shows the absolute runner path of the file (Codex sends absolute paths). Switching provider mid-thread (S20) used to leak T3's handoff prompt into the
  echo answer (the echo scenario now masks it). Sidebar thread titles come from the prompt text, not the scenario title (hidden routing has no tag). Real `codex` behaviour that depends on a
  model (planning, tool choice) is not simulated.

## Claude adapter

A third protocol flavor on the same scenario IR: T3's `claudeAgent` driver (Claude icon, "Claude Opus/Sonnet/Fable/Haiku 5.x" model picker, Settings > Providers card
"Authenticated · Claude Max Subscription", effort picker, Plan/Chat toggle), fully keyless: no `ANTHROPIC_API_KEY`, no credentials, no network.

```
T3 claudeAgent driver ──Agent SDK spawns──▶ <binaryPath> --output-format stream-json --verbose --input-format stream-json
                                              [--permission-mode M] [--session-id=ID | --resume=ID] [--model M] --permission-prompt-tool stdio ...
                                              = mockkit/bin/mock-cli.sh (MOCK_CLI_FLAVOR=claude, or argv --output-format/--input-format/auth)
                                                   └─▶ bin/t3-mock-claude.mjs ──▶ adapters/claude.mjs   (stream-json: control_request/response + SDK messages)
version probe ──▶ <binaryPath> --version                    "2.1.300 (Claude Code)"  (>= every current model's minVersion in T3's manifest)
text generation ──▶ <binaryPath> -p --output-format json --json-schema S ...   prompt on stdin, {"type":"result","structured_output":{..}} on stdout
```

Protocol recon: `@anthropic-ai/claude-agent-sdk` 0.3.276 (`sdk.mjs` / `sdk.d.ts`: spawn args, control-request subtypes, `can_use_tool` shape) and T3's
`orchestration-v2/Adapters/ClaudeAdapterV2.ts` + `testkit/fixtures/claude_*` (message shapes). The adapter was also driven with the REAL SDK
(`query({pathToClaudeCodeExecutable})`, same code path as T3; `ctl/claude-sdk-drive.mjs`, manual, needs the SDK installed) in addition to the hand-written-frame unit tests.

* **Provider selection.** `MOCK_PROVIDER=claude` (read by `seed/settings.mjs`) writes `providerInstances.claudeAgent` enabled (`config.binaryPath` = launcher, env
  `MOCK_CLI_FLAVOR=claude`), disables grok/codex, and points `textGenerationModelSelection` at `claudeAgent` / `claude-haiku-5-5`. `all` = grok+codex+claude, `both` is still
  grok+codex, and any `+` list works (`claude+grok`; first entry = text-generation provider). `MOCK_CLI_MODE=unauth|old|broken|missing` varies the probe (signed out /
  v2.0.1 outdated / non-zero exit / binary absent). `seedInstances` accepts `driver: "claudeAgent"` for extra instances (S18).
* **Driver selection in CI.** `scenarios=claude` (pack: 20 drivers) | `claude-smoke` | `s03@claude,s08@claude` (`@claude` suffix) | env `MOCK_PROVIDER=claude`. Runs are named
  `claude-<driver>` (`after-claude-s03-markdown-stream-done.png`). The same driver files run for every provider (`providerOf(env) === "claude"` branches: S11b plan toggle in the
  composer overflow menu, S14, S18, S20); Claude-only drivers: `s22-session-resume`, `s23-slash-commands` (they print a FINDING and return for other providers).
* **Probe.** `--version`; then the SDK `initialize` control request -> `{commands, agents, models, account:{email, subscriptionType:"max", tokenSource:"claude.ai", apiProvider:"firstParty",
  apiKeySource:"none"}}` (T3 reads auth from this; `unauth` mode reports `tokenSource:"none"` -> "Claude Code is not authenticated"); `get_usage` -> 5-hour 23% / 7-day 41% windows;
  `mcp_set_servers` (T3 registers its own `t3-code` MCP server on every session) -> `{added:[...]}`; `set_model`, `set_permission_mode`, `interrupt`, `apply_flag_settings`, `stop_task`... -> success,
  anything else -> `control_response` error (never a hang). `claude auth status` -> JSON `{loggedIn, authMethod:"claude.ai", ...}`.
* **Turns.** Each `user` message runs one scenario (tag `[mock:id]`, else the hidden per-cwd `mockctl next` queue, else `echo`): `system init` (model, permissionMode, session id) ->
  `stream_event`s -> `assistant` snapshot per content block (own `uuid`, T3 keys text by it) -> `user` tool_result frames -> `result` (usage, `modelUsage`, `user_message_uuid` echo, `terminal_reason`).
  IR mapping: `say` -> text block (`text_delta`s + snapshot), `think` -> thinking block (T3 renders `thinking_delta` live), `read` -> `Read` + numbered result, `fsWrite` -> `Edit`
  (smallest old/new region) or `Write` (REAL write, `structuredPatch`), `sh` -> `Bash` (REAL `sh -c`, `{stdout,stderr,interrupted}`), generic `tool` kinds -> `Grep` / `mcp__mockkit__*`, `plan` -> `TodoWrite`
  (Tasks panel), `exitPlan` -> `ExitPlanMode {plan}` + `can_use_tool` (T3 captures the plan and denies, exactly as with the real CLI), `ask` -> `AskUserQuestion` + `can_use_tool`
  (answers `{questionText: label}`), `error` -> synthetic assistant `API Error: ...` + `is_error` result, `error{kind:"usage_limit"}` -> `rate_limit_event` (rejected, `five_hour`, resetsAt) + assistant
  `error:"rate_limit"` + `blocking_limit` result (T3: "Claude usage limit reached ... resets in 3h", Limited sidebar badge, Resume/Snooze bar), `hold` / queue / `tokens=<n>` unchanged.
* **Permissions follow Claude Code semantics:** `permission` steps send `can_use_tool` (title "Claude wants to create/run/edit ...", `permission_suggestions` setMode acceptEdits / addRules) only in
  `default`/`plan` mode. `bypassPermissions` ("Full access") and `dontAsk` never ask, `acceptEdits` auto-allows Edit/Write, an accepted `addRules` / `setMode` suggestion is remembered; `AskUserQuestion` and
  `ExitPlanMode` always ask. Approval drivers switch the composer to "Supervised". `set_permission_mode` at runtime is honored.
* **Interrupt / resume.** `interrupt` aborts the running turn -> `error_during_execution` result (T3: "Run interrupted by user"). Session state (turn count, history, model, mode) is persisted under
  `$MOCK_CONTROL_DIR/claude-sessions/<id>.json`, so a respawn with `--resume=<id>` (S22) keeps counting.
* **Text generation.** `-p ... --json-schema S`: JSON for the schema's `properties` keys (shared `lib/textgen.mjs`; titles from the scenario, commit subject "Update files via mock agent", S24).
* **Limits (honest).** T3 renders assistant text only from the completed `assistant` snapshot (it ignores `text_delta`), so Claude text appears per finished block, not word by word: the mock closes a
  text block after 350 ms without a delta so held/paused turns still show their text, and a long single `say` (S03) shows up whole. Thinking and tool rows do stream live. Model names, version and the
  context window ("190k/1m") come from T3's bundled manifest, not from the mock; every answer is scripted. No subagents (`Agent` tool), background tasks, hooks, MCP tool calls, skills, `/compact` execution
  (T3 adds the command itself), file checkpointing / rewind, image blocks or `get_context_usage` realism. The tool path in approval cards is the absolute runner path (Claude sends absolute `file_path`).
  Settings > Providers still lists the disabled built-in Codex/Grok rows, and S20 deliberately seeds Grok next to Claude.

## Known limits

* ACP (grok), Codex (`app-server`) and Claude (`stream-json`) flavors are implemented. pi / opencode adapters are not built (see "Codex adapter" / "Claude adapter" for their limits).
* Standard ACP `plan` renders as a todo list; a ProposedPlanCard comes from the xAI `exit_plan_mode` request (IR step `exitPlan`, scenario `exit-plan`, S11b).
* The `acpRegistry` driver does not map upstream xAI rate-limit frames; use the grok driver (`MOCK_UPSTREAM_AGENT`) for S14.
* T3 (web) does not render streamed stdout of an in-progress command: the row reads "Running command" and is not expandable until the
  step completes (run 39935674895). S07 therefore stills the genuine in-progress state (`running-live-status`) and the completed
  output (`done`); a driver FINDING line records it. A `running-midstream` shot is only taken if "step 3/8".."5/8" ever appears in the DOM.
* Cost of isolation: one cold `vp run dev` boot per scenario (~30 s each) instead of one shared server.
* Runner hostname (`runnervm...`) and absolute runner/workspace paths are masked in the DOM of every web shot/video (`lib/mask.mjs`); canvas/xterm text and shadow-DOM text are not covered.
* Mock state is per process (per session); `session/load` after a respawn starts with turn 0.
* No fake credential file is written on purpose (the Grok usage probe would call the network).

## Known evidence limits (from adversarial review, 2026-10)

- Drivers now assert the specific text/element/disk state that proves each step (see "Evidence hardening"); still view the PNG, `RESULT ok` only means the assertions held.
- (fixed, see "Evidence hardening") S24 message source, S28 background-task UI, S37 tree clicks + rendered markdown, S20 leaked handoff prompt.
- S07: T3 does not render in-progress stdout, so no mid-stream output still exists (an in-progress status still + the completed output are captured).
- S40 clip is a 30 s tail starting at the held state; early growth is in the timed PNGs. The `s40-held` UI dump can have 0 nodes (vacuous guard); server truth is the real check.
- Hostname/path masking is DOM text replacement: input values are masked only while no field is focused; the desktop path installs the same mask over CDP (verified in CI, run 40014597750: s03/s06/s08 green, the root X11 capture shows `sandbox-vm`).
- Claude pack: S03 "streaming" and "done" shots look alike (T3 shows Claude text per finished block); S18's detail pane is the Claude card only because the driver clicks `Select Claude`; the account email is blurred by T3. Plan-mode UI (S11b) exists only with the client setting `planModeEnabled` (the driver sets it). Claude-pack drivers s22/s23 are Claude-only and pass vacuously (FINDING line) when run for another provider.
- iOS live path (`mobile-live.sh ios`) is written but untested: the upstream showcase pairing flake blocked both attempts.

## Evidence hardening (track tighten)

CI: `sandbox.yml` with `scenarios=web`, `wide` and `codex` on branch `track-tighten` (all green; evidence dirs on the `evidence` branch) (branch `track-tighten`).

* **Assertions.** `lib/ui.mjs` has `expectText` / `expectVisible` / `expectBody` / `expectLocatorText` / `expectNoText` (each dumps the page and throws
  "assertion failed: expected ..."). Every web driver asserts the state that proves its step: rendered markdown (table/pre/heading, no raw `|---|`), tool
  rows, `+5 -1` counter, diff rows, approval card + the file/`dist/keep.txt` on disk before/after, option echoed back, queue contents, `Run interrupted`,
  provider status lines, `74% - 190k/258k` context tooltip, sidebar section counts, palette hits. Playwright text locators pierce open shadow DOM (diff
  panel, file tree, code views), `body.innerText` does not: use `getByText` for those.
* **Masking.** `lib/mask.mjs` `buildMaskRules({ws, root})` (runner hostname -> `sandbox-vm`, `<ws>` -> `/home/dev/demo-app`, run root / `RUNNER_TEMP` /
  `/home/runner` -> `/home/dev/...`) is installed as a context init script (`scenario.mjs`) or page init script + immediate evaluate (`desktop-scenario.mjs`,
  CDP): a MutationObserver rewrites text nodes, an interval rewrites `<input>` values (never while a field is focused), and `maskNow(page)` sweeps right
  before every screenshot (`run({beforeShot})` in `lib.mjs`). `MASK-LEAK` in the log = something still visible after the sweep. Unit tests: `test/mask.test.mjs`.
* **S01.** `meta.seed = {grok: "codex"}`: the wizard only offers Codex + Claude, so the mock Codex provider is seeded; Agents step shows Codex `Ready`
  ("Connected with your Codex CLI."), Claude `Disabled`; Projects step -> "Do not import projects" -> app shell; reload does not bring the wizard back.
* **S20.** T3 prepends `Context handoff (full_thread_summary): ...\n\nUser message:\n<text>` after a provider switch; `select.mjs stripHandoff()` drops the
  preamble so the echo reply quotes only the user's message (unit test in `acp.test.mjs`). Driver asserts the reply, no handoff text, the `Context handoff` row
  and the new model in the composer. Works for grok and codex (shared `userRequest`).
* **S24.** Both adapters log `{dir:"textgen", reply}`; the driver requires the commit subject to equal the stub subject AND a `textgen` log entry with that
  subject (FINDING line prints agent/seq), plus both files in `git show --stat`.
* **S28.** New IR step `bgTask` + scenario `background-task` (ACP/Grok only, frames from upstream `grok_monitor` / `grok_background_bash`): persistent Monitor
  (`task_backgrounded`, `background_tasks`, tool result `{type:"Monitor", persistent:true}`) ends the turn (thread Done) while the task is pending ->
  composer banner `Running: Start monitor: Watch the dev server` + Stop (asserted while a hold gate keeps the task open). Releasing the gate sends
  `_x.ai/task_completed` plus Grok's own `task-completed-<id>` wake turn (TaskOutput tool result + reply): T3 shows `Monitor "..." finished` and the reply.
  The monitor's own running item is only closed by Stop (the mock sends no kill result), so the banner comes back after the wake run; the driver asserts that
  clicking Stop clears it. `kind=command` variant: T3 holds the root turn open ("Working", tool row "Running ...") until the command is reported done, no
  banner. Unit tests in `acp.test.mjs`.
* **S34.** Settings opened from the sidebar, sections via the settings nav (diagnostics/licenses by route), settings search combobox, `Use light|dark mode`
  tiles, `appearance.cycle` shortcut, `Use Ocean theme` (the card itself is never `aria-pressed`; the active state is on its preview circles + `html[data-theme-id]`).
* **S37.** Tree rows (`@pierre/trees`, shadow DOM) are `button[role=treeitem][data-item-path]`; the text locator used before matched the off-screen "parked"
  duplicate. Locate `[data-type="item"][role="treeitem"]:not([data-item-parked])`, plain click works (ladder kept: click, force, dispatch, Enter). Markdown: header toggle
  `Show rendered markdown` -> real `<h1>`/list/table. Image: `<img alt="assets/logo.svg">` with decoded pixels.
