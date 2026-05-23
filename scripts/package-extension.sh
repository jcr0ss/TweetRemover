#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync('manifest.json','utf8')); process.stdout.write(m.version);")"
OUT_DIR="$ROOT/dist"
OUT_FILE="$OUT_DIR/TweetRemover-v${VERSION}-chrome-web-store.zip"

mkdir -p "$OUT_DIR"
rm -f "$OUT_FILE"

zip -q -r "$OUT_FILE" \
  manifest.json \
  content.js \
  popup.html \
  popup.js \
  icon16.png \
  icon48.png \
  icon128.png

echo "$OUT_FILE"
