#!/usr/bin/env bash
# Render src/assets/icon.png (1024) and src/assets/icon.icns from src/assets/icon.svg.
# Needs rsvg-convert (brew install librsvg) and iconutil (macOS). Commit the outputs; packaging
# reads icon.icns and doesn't run this.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src/assets/icon.svg"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ICONSET="$WORK/icon.iconset"
mkdir "$ICONSET"
for size in 16 32 128 256 512; do
  rsvg-convert -w "$size" -h "$size" "$SRC" -o "$ICONSET/icon_${size}x${size}.png"
  rsvg-convert -w $((size * 2)) -h $((size * 2)) "$SRC" -o "$ICONSET/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$ICONSET" -o "$ROOT/src/assets/icon.icns"
cp "$ICONSET/icon_512x512@2x.png" "$ROOT/src/assets/icon.png"
echo "Wrote src/assets/icon.icns and src/assets/icon.png"
