#!/usr/bin/env bash
# publish-evidence.sh <src-dir> <label>
# Flattens PNG/MP4/WEBM under <src-dir> (skipping diag/), adds a short GIF per video, pushes to
# orphan branch `evidence` under <run-id>-<label>/, prints PR-ready markdown to the step summary.
# Env: GH_TOKEN GITHUB_REPOSITORY GITHUB_RUN_ID [GITHUB_STEP_SUMMARY]
set -euxo pipefail
src=${1:?src dir}
label=${2:?label}
[ -d "$src" ] || { echo "no artifacts at $src; nothing to publish"; exit 0; }

run="${GITHUB_RUN_ID}-${label}"
pub=$(mktemp -d)
command -v ffmpeg >/dev/null || { echo "ffmpeg required (use setup-ffmpeg)"; exit 1; }

while IFS= read -r -d '' f; do
  rel=${f#"$src"/}
  case "$rel" in diag/*|*/diag/*) continue ;; esac
  flat=${rel//\//__}
  case "$f" in
    *.png) cp "$f" "$pub/$flat" ;;
    *.mp4|*.webm)
      base=${flat%.*}
      timeout 120 ffmpeg -nostdin -loglevel error -y -i "$f" -c:v libx264 -pix_fmt yuv420p "$pub/$base.mp4"
      # GIF for inline embedding: first 15 s, <=480 px wide, 8 fps.
      timeout 120 ffmpeg -nostdin -loglevel error -y -t 15 -i "$f" -vf "fps=8,scale='min(480,iw)':-1:flags=lanczos" "$pub/$base.gif"
      ;;
  esac
done < <(find "$src" -type f \( -name '*.png' -o -name '*.mp4' -o -name '*.webm' \) -print0)

if [ -z "$(ls -A "$pub")" ]; then echo "no media found"; exit 0; fi

remote="https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}"
git config --global user.name "github-actions[bot]"
git config --global user.email "41898282+github-actions[bot]@users.noreply.github.com"
work=$(mktemp -d)
if ! timeout 120 git clone -q --depth 1 --branch evidence "$remote" "$work/ev" 2>/dev/null; then
  git init -q "$work/ev"
  git -C "$work/ev" checkout -q --orphan evidence
  git -C "$work/ev" remote add origin "$remote"
fi
mkdir -p "$work/ev/$run"
cp "$pub"/* "$work/ev/$run/"
git -C "$work/ev" add -A
git -C "$work/ev" commit -q -m "evidence $run"
for _ in 1 2 3; do
  timeout 120 git -C "$work/ev" push -q origin evidence && break
  timeout 120 git -C "$work/ev" pull -q --rebase origin evidence
done

raw="https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/evidence/${run}"
blob="https://github.com/${GITHUB_REPOSITORY}/blob/evidence/${run}"
{
  echo "### Evidence markdown: $label"
  echo '```markdown'
  for f in "$pub"/*.png "$pub"/*.gif; do [ -f "$f" ] && echo "![$(basename "$f")]($raw/$(basename "$f"))"; done
  for f in "$pub"/*.mp4; do [ -f "$f" ] && echo "[$(basename "$f")]($blob/$(basename "$f")?raw=true)"; done
  echo '```'
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
