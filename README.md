# gha-sandbox

Free, one-off Linux VM for PR repro + UI evidence, via GitHub Actions on a public repo.
Not long-lived: every run is a fresh runner. Offloads builds/browsers from a low-RAM laptop.

```sh
scripts/sbx run 1234 scenarios/example.mjs            # PR number of target repo (default pingdotgg/t3code)
scripts/sbx run my-branch scenarios/x.mjs --sides after
scripts/sbx run 1234 --shell                          # tmate SSH, actor only
```

Runs `before` (base_ref, default main) and `after` (head_ref) in parallel, same scenario
(`lib.mjs` `run()` -> Playwright + video). Publish job builds side-by-side PNGs + GIF/MP4,
uploads to release `evidence-<run-id>` in THIS repo, prints PR markdown in the run summary.

Evidence lives here, never committed to the target repo (t3code CONTRIBUTING.md:92-94).

## Rules

- Public repo only (free minutes). No secrets in repo. Target code is untrusted: never use `pull_request_target`.
- Use for testing a project's PRs (Actions ToS: usage tied to project testing).
- Status: untested. Open items: `vp` install path, `pairingUrl:` log format, release-asset image embedding.
