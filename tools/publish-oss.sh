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

# --- Stage into a scratch dir first — the gate must clear BEFORE anything
# touches $DST. (2026-08-08: an aborted run used to leave rsync's output
# sitting in $DST uncommitted, since rsync ran unconditionally ahead of the
# grep gate — a partial publish contaminating the target on every gate trip.)
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

rsync -a --exclude-from="${SRC}.oss-exclude" "$SRC" "$STAGE/"

# --- Sweep gate: scan the STAGE for private strings before touching $DST ---

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
  'BACKLOG.md'
)

grep_args=(-rIn --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.wrangler --exclude=publish-oss.sh -i)
for term in "${FORBIDDEN[@]}"; do
  grep_args+=(-F -e "$term")
done

forbidden_hits="$(grep "${grep_args[@]}" "$STAGE" || true)"
if [ -n "$forbidden_hits" ]; then
  echo "abort: forbidden private strings found in staged export — fix before publishing ($DST untouched):" >&2
  printf '%s\n' "$forbidden_hits" >&2
  exit 1
fi

# pogotips / pogo.tips allowed only at LICENSE:3 and README.md:66
brand_hits="$(grep -rIn --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.wrangler --exclude=publish-oss.sh -i -F -e 'pogotips' -e 'pogo.tips' "$STAGE" || true)"
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
  echo "abort: pogotips/pogo.tips found outside the allowed LICENSE:3 / README.md:66 lines ($DST untouched):" >&2
  printf '%s' "$brand_violations" >&2
  exit 1
fi

# --- Filename-leak gate: .oss-exclude keeps internal docs (SHIP_REPORT_*,
# *_AUDIT_*, *_REVIEW_*, *_PREMORTEM_*, etc) out of the publish, but a code
# comment can still leak one's existence by naming it directly (2026-08-18
# incident: 3 such references shipped via a merged PR before this gate
# existed). Scans STAGE content for the same naming-convention tokens
# .oss-exclude's own wildcard globs define — see tools/oss-filename-leak-check.mjs.
if ! node "${SCRIPT_DIR}/oss-filename-leak-check.mjs" "$STAGE"; then
  echo "abort: fix the leak(s) above before publishing ($DST untouched)" >&2
  exit 1
fi

# --- Gate cleared — now, and only now, sync into $DST ---

# --exclude-from is REQUIRED here, not just on the SRC->STAGE pass above.
# (2026-08-08 incident: this rsync ran with --delete and no exclude-from —
# STAGE never contains .git since it's excluded on the first pass, so
# --delete read that as "DST/.git isn't in the source, remove it" and wiped
# the target repo's git history. rsync only protects a destination path
# from --delete when that path also matches an active exclude pattern; drop
# this flag and DST/.git is unprotected again.)
rsync -a --delete --exclude-from="${SRC}.oss-exclude" "$STAGE/" "$DST"

test -d "$DST/.git" || {
  echo "abort: $DST/.git is missing after sync — the publish step just" >&2
  echo "destroyed the target repo's git history. Do not proceed. Re-clone" >&2
  echo "$DST from its remote before running this script again." >&2
  exit 1
}

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
