#!/bin/sh
# Fake `grok` (and `codex`, see MOCK_CLI_FLAVOR below) CLI launcher. Mirrors packages/provider-testing fakeCli.
#   codex flavor: codex app-server | exec ... | mcp list --json | --version -> bin/t3-mock-codex.mjs
#   grok --version                       -> grok 1.0.13
#   grok models                          -> login line + model bullets (parsed by status.ts)
#   grok inspect --json                  -> {"skills":[]}
#   grok [--permission-mode X] agent [--always-approve] stdio  -> mock ACP agent
# MOCK_CLI_MODE=ready|unauth|old|broken|missing varies probe output (provider-status scenarios).
# No fake credential file is ever written (the usage probe would otherwise hit the network).
HERE=$(cd "$(dirname "$0")" && pwd)
MODE=${MOCK_CLI_MODE:-ready}
case "$MODE" in
  missing) echo "mock: command not found" >&2; exit 127 ;;
  broken) echo "mock: broken CLI" >&2; exit 1 ;;
esac
NODE=${MOCK_NODE:-$(command -v node)}

# Probe trace: the CI harness polls $MOCK_CONTROL_DIR/probes.log to know T3 has probed the provider (readiness).
CTL=${MOCK_CONTROL_DIR:-}
if [ -n "$CTL" ] && mkdir -p "$CTL" 2>/dev/null; then
  echo "$(date +%s) $*" >> "$CTL/probes.log" 2>/dev/null || true
fi

for a in "$@"; do
  case "$a" in
    --version)
      if [ "${MOCK_CLI_FLAVOR:-}" = codex ]; then exec "$NODE" "$HERE/t3-mock-codex.mjs" "$@"; fi
      if [ "$MODE" = old ]; then echo "grok 0.0.1"; else echo "grok 1.0.13"; fi
      exit 0 ;;
  esac
done

# Codex flavor (T3's codex driver spawns `<binaryPath> app-server`, `exec ...`, `mcp list --json`): chosen by
# MOCK_CLI_FLAVOR=codex (seeded on codex instances) or by those subcommands, which grok never receives.
FLAVOR=${MOCK_CLI_FLAVOR:-}
if [ -z "$FLAVOR" ]; then
  for a in "$@"; do
    case "$a" in app-server|exec|mcp) FLAVOR=codex ;; esac
  done
fi
if [ "$FLAVOR" = codex ]; then exec "$NODE" "$HERE/t3-mock-codex.mjs" "$@"; fi

case "$1" in
  models)
    if [ "$MODE" = unauth ]; then
      echo "You are not logged in. Run grok login."
    else
      printf 'You are logged in\n  * grok-build (default)\n  - grok-mock-fast\n'
    fi
    exit 0 ;;
  inspect)
    echo '{"skills":[]}'
    exit 0 ;;
esac

for a in "$@"; do
  if [ "$a" = agent ]; then
    # MOCK_UPSTREAM_AGENT=<path to t3code apps/server/scripts/acp-mock-agent.ts>: serve the upstream mock (T3_ACP_* flags) instead.
    if [ -n "${MOCK_UPSTREAM_AGENT:-}" ]; then
      exec "$NODE" --experimental-strip-types --no-warnings "$MOCK_UPSTREAM_AGENT"
    fi
    exec "$NODE" "$HERE/t3-mock-acp.mjs"
  fi
done

echo "mock grok: unsupported args: $*" >&2
exit 2
