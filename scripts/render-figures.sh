#!/usr/bin/env bash
# Render the README figures: docs/images/src/<name>.html -> docs/images/<name>.png, at 2x.
# Needs Google Chrome and ImageMagick (magick). On macOS the figures use SF Mono from Terminal.app;
# elsewhere they fall back to another monospace font.
#
#   scripts/render-figures.sh              # every figure
#   scripts/render-figures.sh whats-next   # just one
set -euo pipefail

cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if [ "$#" -gt 0 ]; then
  names=("$@")
else
  names=()
  for src in docs/images/src/*.html; do names+=("$(basename "$src" .html)"); done
fi

for name in "${names[@]}"; do
  src="$PWD/docs/images/src/${name}.html"
  out="$PWD/docs/images/${name}.png"
  # A tall transparent page, then trim to the window and its shadow
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --default-background-color=00000000 --allow-file-access-from-files \
    --window-size=1100,2400 --screenshot="$out" "file://${src}" >/dev/null 2>&1
  magick "$out" -trim +repage -bordercolor none -border 6 "$out"
  echo "${out#"$PWD"/} $(magick identify -format '%wx%h' "$out")"
done
