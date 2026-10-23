#!/bin/sh
# Seed a tiny git workspace for mock scenarios (edit-file-diff expects src/greeting.ts).
#   workspace.sh <dir>
set -eu
dir=${1:?dir}
mkdir -p "$dir/src"
cd "$dir"
cat > README.md <<'EOT'
# demo-app

A tiny TypeScript package used by the T3 Code mock agent scenarios.
EOT
cat > package.json <<'EOT'
{
  "name": "demo-app",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "build": "tsc" }
}
EOT
cat > src/greeting.ts <<'EOT'
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
EOT
export GIT_AUTHOR_NAME=Mock GIT_AUTHOR_EMAIL=mock@example.invalid GIT_COMMITTER_NAME=Mock GIT_COMMITTER_EMAIL=mock@example.invalid
export GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z
[ -d .git ] || git init -q -b main
git add -A
git commit -q -m "Initial commit" || true
echo "workspace ready: $dir"
