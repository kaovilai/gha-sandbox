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
| `bin/t3-mock-acp.mjs`, `bin/mock-cli.sh` | entrypoint; fake grok launcher (`--version`, `models`, `inspect --json`, `agent stdio`) |
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
4. Add the id to `targets/t3code-mock/set-all.mjs` (or set `SCENARIOS`).

## Env vars

`MOCK_LOG` (NDJSON), `MOCK_PACE` (fast/real/slow), `MOCK_SEED`, `MOCK_DEFAULT_SCENARIO`, `MOCK_CONTROL_DIR`,
`MOCK_HOLD_TIMEOUT_MS`, `MOCK_CLI_MODE` (ready/unauth/old/broken/missing, launcher probe output),
`MOCK_KEEP_OTHER_PROVIDERS`, `MOCK_NODE`. Baseline no-cloud env set by `start.sh`: `T3CODE_TELEMETRY_ENABLED=false
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

## Known limits

* Only the ACP flavor (grok) is implemented. Codex / pi / claude / opencode adapters and mobile/desktop are not built.
* Standard ACP `plan` renders as a todo list; a ProposedPlanCard needs xAI `exit_plan_mode` frames (not implemented).
* T3 (web) does not render streamed stdout of an in-progress command: the row reads "Running command" and is not expandable until the
  step completes (run 39935674895). S07 therefore stills the genuine in-progress state (`running-live-status`) and the completed
  output (`done`); a driver FINDING line records it. A `running-midstream` shot is only taken if "step 3/8".."5/8" ever appears in the DOM.
* Cost of isolation: one cold `vp run dev` boot per scenario (~30 s each) instead of one shared server.
* Runner hostname (`runnervm...`) still shows in the project panel (not masked).
* Mock state is per process (per session); `session/load` after a respawn starts with turn 0.
* No fake credential file is written on purpose (the Grok usage probe would call the network).
