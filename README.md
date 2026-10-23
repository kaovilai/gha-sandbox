# gha-sandbox

Free, one-off Linux/macOS VMs for PR repro + UI evidence, via GitHub Actions on a public repo.
Not long-lived: every run is a fresh runner. Offloads builds/browsers/emulators from a low-RAM laptop.
Evidence never goes into the target repo (t3code CONTRIBUTING.md:92-94); it lands on this repo's
orphan `evidence` branch (raw URLs serve `image/*`, so PNG/GIF embed inline in PRs).

## Status (target: pingdotgg/t3code)

| Platform | Workflow | State |
|---|---|---|
| Web | `sandbox.yml` | Working: before/after matrix, Playwright screenshots + video, side-by-side, evidence branch |
| Desktop (Linux Electron) | `desktop-linux.yml` | Working: real built app under Xvfb, onboarding clicked through, screenshot + 12 s recording, published |
| Android app | `android-app.yml` | Working: KVM emulator, native build, seeded screenshots (upstream showcase) + recording, published |
| iOS app | `ios-app.yml` | Partial: simulator + native build + JS load work, one full success; pairing step is flaky (see below) |
| Emulator capability probes | `emulators.yml` | Working: Android + iOS boot, screenshot, recording |
| Re-publish any run's artifacts | `publish-run.yml` | Working |

## Using it for other projects (profiles)

The web workflow (`sandbox.yml`) is target-agnostic. Everything project-specific lives in
`targets/<profile>/`; t3code is just the default profile.

| File | Purpose |
|---|---|
| `profile.env` | `USES_VP=1` to set up Vite+ (`vp`), else plain Node; `NODE_VERSION` |
| `setup.sh` | install deps (cwd = target checkout) |
| `start.sh` | start the app; log to `$APP_LOG`, write the URL to open into `$APP_URL_FILE` |
| `scenario.mjs` | Playwright script using `run()` from `lib.mjs`: `shot(name)` + auto video |

```sh
# any public repo that serves static files from its root
gh workflow run sandbox.yml -f profile=static -f repo=mdn/beginner-html-site-styled \
  -f base_ref=main -f head_ref=main
scripts/sbx run 1234 --profile t3code        # t3code PR 1234 (default profile + repo)
```

To add a project: copy `targets/static/`, edit `start.sh` for its dev server, and write a
scenario. Verified profiles: `t3code` (full before/after on a real PR), `static` (MDN sample
site). `desktop-linux.yml`, `android-app.yml` and `ios-app.yml` are still t3code-specific
(they reuse upstream's `mobile-showcase` tooling); the same profile split is the path to
generalize them. For an arbitrary APK/`.app`, `emulators.yml` shows the boot + screenshot +
recording mechanics to build on.

## Usage

```sh
scripts/sbx run 1234 scenarios/example.mjs            # web: PR number of target repo
gh workflow run desktop-linux.yml -f ref=pull/1234/head
gh workflow run android-app.yml   -f ref=pull/1234/head
gh workflow run ios-app.yml       -f ref=pull/1234/head [-f keep_running=true]
gh workflow run publish-run.yml -f run_id=<id> -f artifact=out-android-app -f label=android-app
```

## Hard-won runner findings (free tier: ubuntu 4 vCPU/16 GB, macOS 3 vCPU/7 GB)

- `vp`: use `voidzero-dev/setup-vp@<exact tag>`; the floating `v1` tag is frozen. Install pnpm via npm at the target's pinned version.
- **apt stalls** on runners (10+ min, even non-interactive). Use `scripts/apt-install.sh` (IPv4, timeouts, retries) and `FedericoCarboni/setup-ffmpeg` (no arm64 macOS support) instead of `apt install ffmpeg`.
- Desktop: dev mode always opens DevTools (`DesktopWindow.ts`); run the built app (`build:desktop` + `start:desktop`). Needs `libsecret-1-dev`, `xdotool`, `sysctl kernel.apparmor_restrict_unprivileged_userns=0`.
- Android: runner already has `/swapfile`; add a second swap under `/mnt`; lower Node/Gradle/emulator memory or Gradle gets OOM-killed. `screenrecord` cannot write `/sdcard`; use `/data/local/tmp`.
- iOS (macOS runner), in order of discovery:
  1. Metro's manifest answers in 7-25 s but the Expo dev launcher times out at 10 s, and it probes with **HEAD** first. `scripts/metro-manifest-proxy.mjs` caches GET+HEAD manifest and the iOS Metro URL is pointed at it (:8200).
  2. Upstream warms Metro with a different bundle URL than the app requests; `patch-showcase-warm.py` warms the exact `index.ts.bundle?...hermes...reactCompiler` variant.
  3. iOS uses loopback (not the runner LAN IP) for Metro.
  4. `--keep-running` + `| tee` deadlocks (Metro holds the pipe); redirect to a file.
  5. Upstream's hard-coded 90-120 s scene waits are patched in the throwaway checkout.
  - **Open:** after the app loads, seeded-server pairing intermittently never happens ("No environments connected"), so scene `thread` never renders. One full success (real seeded screenshots), then 5+ failures with identical config; 4x150 s retries inside the 5 min pairing-token TTL did not help. Next step is server-side/app-side logging of the pairing call.
- Artifact egress: repeated downloads of large recordings hit "Egress is over the account limit" (HTTP 503); read job logs instead, keep recordings short, and prune the `evidence` branch.

## Rules

- Public repo only (free minutes). No secrets in repo. Target code is untrusted: never use `pull_request_target`.
- Use for testing a project's PRs (Actions ToS: usage tied to project testing).
