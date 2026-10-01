#!/usr/bin/env bash
# render.sh OUT_DIR file.md [file.md ...]
#
# Render each markdown file to OUT_DIR/<name>.html in the monochrome
# infographic style, with Mermaid blocks rendered client-side. Idempotent.
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: render.sh OUT_DIR file.md [file.md ...]" >&2
  exit 2
fi

OUT=$1
shift
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
mkdir -p "$OUT"
cp "$HERE/style.css" "$OUT/style.css"

if command -v pandoc >/dev/null 2>&1; then
  pandoc() { command pandoc "$@"; }
else
  pandoc() { nix run nixpkgs#pandoc -- "$@"; }
fi

for src in "$@"; do
  name=$(basename "${src%.md}")
  out="$OUT/$name.html"
  title=$(grep -m1 '^# ' "$src" | sed 's/^# //')
  pandoc -s --from gfm --to html5 --wrap=none \
    --metadata pagetitle="${title:-$name}" \
    -H "$HERE/header.html" \
    "$src" -o "$out"
  # --stats adds the noun/verb/rule number row, and does nothing on a file
  # that has no such tables, so every page can ask for it.
  python3 "$HERE/postprocess.py" "$out" --stats --source "$(basename "$src")"
  echo "rendered: $out"
done
