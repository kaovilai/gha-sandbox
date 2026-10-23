#!/usr/bin/env python3
"""iOS live: pair with a FRESH credential on every attempt (throwaway checkout; JS/TS only, no native rebuild).

usage: patch-showcase-ios-pairing.py <scripts/mobile-showcase.ts> <ShowcaseCaptureCoordinator.tsx>

1. mobile-showcase.ts writes the kept environments (baseDir/port/label) to $PAIRING_ENVS_FILE so
   scripts/ios-pairing-server.mjs can mint credentials on demand.
2. The coordinator no longer retries a (possibly spent / expired) launch-arg URL: each attempt GETs
   http://127.0.0.1:8201/pairing?port=<port> for a new URL, with a 120 s attempt timeout instead of 10 s (a slow
   attempt used to be abandoned after the credential was already redeemed), and logs every outcome plus the
   fixture state with console.warn (forwarded to Metro's log) so a failed pairing is diagnosable.
"""
import sys

showcase_path, coord_path = sys.argv[1], sys.argv[2]
ok = True

# ---- 1. mobile-showcase.ts -----------------------------------------------------------------------------------------
src = open(showcase_path).read()
anchor = "    for (const capture of captures) {\n      const pairingHost ="
insert = (
    "    await NodeFSP.writeFile(\n"
    '      NodeProcess.env.PAIRING_ENVS_FILE ?? "/tmp/pairing-envs.json",\n'
    "      JSON.stringify(\n"
    "        showcaseEnvironments.map((e) => ({ baseDir: e.baseDir, port: e.port, label: e.label })),\n"
    "      ),\n"
    "    );\n"
)
if src.count(anchor) == 1:
    open(showcase_path, "w").write(src.replace(anchor, insert + anchor, 1))
    print("showcase envs-file patch applied")
else:
    print("WARN: showcase envs-file anchor not found")
    ok = False

# ---- 2. coordinator ------------------------------------------------------------------------------------------------
src = open(coord_path).read()

helpers = """
async function ghaFreshPairingUrl(original: string): Promise<string> {
  try {
    const port = /:(\\d+)\\//u.exec(original)?.[1];
    const response = await fetch(`http://127.0.0.1:8201/pairing?port=${port}`);
    if (!response.ok) {
      console.warn(`[gha-pair] mint http ${response.status} for port ${port}; reusing launch url`);
      return original;
    }
    const fresh = (await response.text()).trim();
    return fresh.length > 0 ? fresh : original;
  } catch (error) {
    console.warn(`[gha-pair] mint failed ${String(error)}; reusing launch url`);
    return original;
  }
}

function ghaDescribe(value: unknown): string {
  try {
    return (
      JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? String(v) : v))?.slice(0, 500) ??
      String(value)
    );
  } catch {
    return String(value);
  }
}

"""
a1 = 'const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === "1";\n'
old_retry = (
    "          const paired = await retryShowcaseOperation(\n"
    "            async () => AsyncResult.isSuccess(await connectPairingUrl(pairingUrl)),\n"
    "            { isCancelled: () => cancelled },\n"
    "          );\n"
)
new_retry = (
    "          const paired = await retryShowcaseOperation(\n"
    "            async () => {\n"
    "              const freshUrl = await ghaFreshPairingUrl(pairingUrl);\n"
    "              const result = await connectPairingUrl(freshUrl);\n"
    "              const success = AsyncResult.isSuccess(result);\n"
    "              console.warn(\n"
    '                `[gha-pair] ${success ? "ok" : "FAILED"} ${freshUrl.replace(/token=[^&]*/u, "token=...")} ${success ? "" : ghaDescribe(result)}`,\n'
    "              );\n"
    "              return success;\n"
    "            },\n"
    "            { isCancelled: () => cancelled, attemptTimeoutMs: 120_000 },\n"
    "          );\n"
)
a3 = "  const showcaseThread = threads.find((thread) => String(thread.id) === SHOWCASE_THREAD_ID);\n"
state_log = (
    "  useEffect(() => {\n"
    "    console.warn(\n"
    "      `[gha-fixture] ready=${workspace.state.hasReadyEnvironment} envs=${workspace.environments.length} projects=${projects.length} threads=${threads.length} thread=${showcaseThread !== undefined} tasks=${pendingTasksReady} route=${scene} req=${requestedScene}`,\n"
    "    );\n"
    "  }, [\n"
    "    workspace.state.hasReadyEnvironment,\n"
    "    workspace.environments.length,\n"
    "    projects.length,\n"
    "    threads.length,\n"
    "    showcaseThread,\n"
    "    pendingTasksReady,\n"
    "    scene,\n"
    "    requestedScene,\n"
    "  ]);\n"
)
if src.count(a1) == 1 and src.count(old_retry) == 1 and src.count(a3) == 1:
    src = src.replace(a1, helpers + a1, 1).replace(old_retry, new_retry, 1).replace(a3, a3 + state_log, 1)
    open(coord_path, "w").write(src)
    print("coordinator fresh-pairing patch applied")
else:
    print("WARN: coordinator anchors not found", src.count(a1), src.count(old_retry), src.count(a3))
    ok = False
sys.exit(0 if ok else 1)
