#!/usr/bin/env bash
# Package each skill as a .zip for upload to claude.ai (Settings > Capabilities > Skills)
# or the Skills API. Output lands in dist/.
#
#   scripts/package.sh              # package every skill
#   scripts/package.sh whats-next   # package one
#
# The archive contains a single top-level directory named after the skill, which is
# what the uploader expects:
#   whats-next.zip
#   └── whats-next/
#       └── SKILL.md

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/skills"
OUT="$ROOT/dist"

command -v zip >/dev/null 2>&1 || { echo "error: zip is not installed" >&2; exit 1; }

# Fail fast rather than shipping an archive the uploader will reject.
python3 "$ROOT/scripts/validate.py" "$SRC" >/dev/null

SKILLS=("$@")
if [ ${#SKILLS[@]} -eq 0 ]; then
  for d in "$SRC"/*/; do
    [ -f "$d/SKILL.md" ] && SKILLS+=("$(basename "$d")")
  done
fi

mkdir -p "$OUT"
for s in "${SKILLS[@]}"; do
  [ -f "$SRC/$s/SKILL.md" ] || { echo "error: no such skill: $s" >&2; exit 1; }
  rm -f "$OUT/$s.zip"
  ( cd "$SRC" && zip -qr "$OUT/$s.zip" "$s" -x '.*' '*/.*' )
  echo "  $OUT/$s.zip"
done
