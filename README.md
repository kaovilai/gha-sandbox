# gha-sandbox

Free, one-off Linux/macOS VMs for PR repro + UI evidence, via GitHub Actions on a public repo.
Not long-lived: every run is a fresh runner. Offloads builds/browsers/emulators from a low-RAM laptop.

## Web (t3code): `sandbox.yml`

```sh
scripts/sbx run 1234 scenarios/example.mjs            # PR number of target repo (default pingdotgg/t3code)
scripts/sbx run my-branch scenarios/x.mjs --sides after
scripts/sbx run 1234 --shell                          # tmate SSH, actor only
```

Runs `before` (base_ref, default main) and `after` (head_ref) in parallel, same scenario
(`lib.mjs` `run()` -> Playwright + video). Publish job builds side-by-side PNGs + GIF/MP4,
pushes them to orphan branch `evidence` under `<run-id>/` in THIS repo (raw URLs serve
`image/*`, so PNG/GIF embed inline), and prints PR markdown in the run summary.
Evidence lives here, never committed to the target repo (t3code CONTRIBUTING.md:92-94).

Verified: both sides, setup-vp, pairing-URL auth, banner dismissal, side-by-side, evidence-branch URLs.
Not verified: inline rendering inside an actual PR comment; `--shell`.
Scenario tip: mask nondeterministic text (runner hostname shows in the UI) so before/after diffs are clean.

## Mobile emulators: `emulators.yml` (capability probes, OS Settings only; no app build yet)

| | Runner | Result |
|---|---|---|
| Android | `ubuntu-latest` + KVM udev rule + `reactivecircus/android-emulator-runner` (API 34, x86_64, google_apis, pixel_6) | boots (~4 min), `screencap` + `screenrecord` work |
| iOS | `macos-latest` (Xcode 26.x) + `xcrun simctl` | boots, `simctl io screenshot` + `recordVideo` work |

Android gotcha: `screenrecord` cannot write `/sdcard`; use `/data/local/tmp`.
t3code mobile is an Expo dev client (native modules, no Expo Go); upstream ships
`scripts/mobile-native-client.ts` + `scripts/mobile-showcase.ts` that build/install/seed/capture.
Next: wire those in; expect 15-30 min native builds per platform (cache Gradle/DerivedData).

## Rules

- Public repo only (free minutes). No secrets in repo. Target code is untrusted: never use `pull_request_target`.
- Use for testing a project's PRs (Actions ToS: usage tied to project testing).
- `evidence` branch grows per run; prune old run dirs periodically.
