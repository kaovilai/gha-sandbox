#!/usr/bin/env bash
# apt-install.sh <pkg>...  Robust apt on GitHub runners: apt has been observed to stall for
# 10+ min, so force IPv4, short network timeouts, and retry with a hard per-attempt cap.
set -uo pipefail
opts=(-o Acquire::ForceIPv4=true -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20
      -o Acquire::Retries=3 -o Dpkg::Options::=--force-confold)
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
for attempt in 1 2 3; do
  echo "apt attempt $attempt"
  if sudo -E timeout 240 apt-get update "${opts[@]}" </dev/null &&
     sudo -E timeout 420 apt-get install -y --no-install-recommends "${opts[@]}" "$@" </dev/null; then
    exit 0
  fi
  echo "apt attempt $attempt failed/timed out; retrying"
  sudo pkill -9 apt-get 2>/dev/null || true
  sudo pkill -9 dpkg 2>/dev/null || true
  sudo dpkg --configure -a 2>/dev/null || true
done
echo "apt failed after 3 attempts"
exit 1
