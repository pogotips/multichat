#!/usr/bin/env bash
# Publish the monorepo multichat/ tree to the standalone oss export.
# Overwrite-only: monorepo multichat/ is the source of truth, ~/multichat-oss
# is the publish target. This script never pushes — it stops after commit.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(dirname -- "$SCRIPT_DIR")/"
DST="${HOME}/multichat-oss"

if [ ! -d "$DST/.git" ]; then
  echo "abort: $DST is not a git repo (missing .git)" >&2
  exit 1
fi

if [ -n "$(git -C "$SRC" status --porcelain -- .)" ]; then
  echo "abort: $SRC has uncommitted changes — commit or stash first" >&2
  exit 1
fi

rsync -a --delete --exclude-from="${SRC}.oss-exclude" "$SRC" "$DST"

# --- Sweep gate: scan DST for private strings before touching git ---

FORBIDDEN=(
  '87f04ad1710df9279714f094339c3b2d'
  '192.168.'
  'term@'
  '/opt/stacks'
  'pogo-raid-queue'
  'tips@warner.me'
  'multichat.pogo.tips'
  'ingest-tail-findings'
  'superpowers'
  'TRIAGE_'
  'GLITCH_AUDIT'
  'BACKLOG'
)

grep_args=(-rIn --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.wrangler --exclude=publish-oss.sh -i)
for term in "${FORBIDDEN[@]}"; do
  grep_args+=(-F -e "$term")
done

forbidden_hits="$(grep "${grep_args[@]}" "$DST" || true)"
if [ -n "$forbidden_hits" ]; then
  echo "abort: forbidden private strings found in $DST — fix before publishing:" >&2
  printf '%s\n' "$forbidden_hits" >&2
  exit 1
fi

# pogotips / pogo.tips allowed only at LICENSE:3 and README.md:66
brand_hits="$(grep -rIn --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.wrangler --exclude=publish-oss.sh -i -F -e 'pogotips' -e 'pogo.tips' "$DST" || true)"
brand_violations=""
if [ -n "$brand_hits" ]; then
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    hit_file="${hit%%:*}"
    hit_rest="${hit#*:}"
    hit_line="${hit_rest%%:*}"
    hit_base="$(basename -- "$hit_file")"
    if [ "$hit_base" = "LICENSE" ] && [ "$hit_line" = "3" ]; then
      continue
    fi
    if [ "$hit_base" = "README.md" ] && [ "$hit_line" = "66" ]; then
      continue
    fi
    brand_violations+="$hit"$'\n'
  done <<<"$brand_hits"
fi

if [ -n "$brand_violations" ]; then
  echo "abort: pogotips/pogo.tips found outside the allowed LICENSE:3 / README.md:66 lines:" >&2
  printf '%s' "$brand_violations" >&2
  exit 1
fi

# --- Commit in DST ---

cd "$DST"
git add -A

if git diff --cached --quiet; then
  echo "no changes — $DST already matches $SRC"
  exit 0
fi

git diff --stat --cached

read -r -p "publish? [y/N] " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
  echo "aborted, changes staged but not committed"
  exit 0
fi

commit_msg="${1:-sync from private}"
git commit -m "$commit_msg"
echo "now run: git push"
