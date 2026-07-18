#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR"
DIST="$SCRIPT_DIR/dist"
TERSER="$SCRIPT_DIR/node_modules/.bin/terser"

rm -rf "$DIST"
mkdir -p "$DIST"

echo "╔══════════════════════════════════════╗"
echo "║   Lensed Extension Build             ║"
echo "╚══════════════════════════════════════╝"
echo ""

rsync -a \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='build.sh' \
  --exclude='validate-build.mjs' \
  --exclude='package.json' \
  --exclude='package-lock.json' \
  --exclude='.DS_Store' \
  --exclude='.git' \
  --exclude='.gitignore' \
  --exclude='.env' \
  --exclude='*.pem' \
  --exclude='*.map' \
  --exclude='*.zip' \
  "$SRC/" "$DIST/"

echo "Copied source files to dist/"

# Stamp the diagnostics build marker with the real short commit SHA (source keeps the
# literal '__BUILD_SHA__' placeholder; only the built dist carries the resolved SHA).
BUILD_SHA=$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || echo "nogit")
if [ -f "$DIST/background.js" ]; then
  (sed -i '' "s/__BUILD_SHA__/${BUILD_SHA}/g" "$DIST/background.js" 2>/dev/null || sed -i "s/__BUILD_SHA__/${BUILD_SHA}/g" "$DIST/background.js")
  echo "Stamped build SHA: $BUILD_SHA"
fi

find "$DIST" -name '*.js' -type f | while read -r jsfile; do
  relpath="${jsfile#$DIST/}"
  "$TERSER" "$jsfile" \
    --compress passes=2,drop_console=false,pure_getters=true \
    --mangle reserved=['chrome','fetch','Request','Response','Headers','URL','AbortController','FormData','Blob','crypto','WebSocket','navigator','document','window','self','globalThis','importScripts','postMessage','addEventListener','removeEventListener','setTimeout','setInterval','clearTimeout','clearInterval','performance','console','localStorage','sessionStorage','XMLHttpRequest'] \
    --mangle-props "regex=/^_[a-z]/" \
    --output "$jsfile" 2>/dev/null
  echo "  Minified: $relpath"
done

echo ""

echo "Validating minified output..."
node "$SCRIPT_DIR/validate-build.mjs" "$DIST"
VALIDATE_EXIT=$?
if [ $VALIDATE_EXIT -ne 0 ]; then
  echo ""
  echo "BUILD FAILED: Validation errors found."
  exit 1
fi
echo ""

SRC_SIZE=$(find "$SRC" -name '*.js' -not -path '*/node_modules/*' -not -path '*/dist/*' -exec cat {} + 2>/dev/null | wc -c | tr -d ' ')
DIST_SIZE=$(find "$DIST" -name '*.js' -exec cat {} + 2>/dev/null | wc -c | tr -d ' ')
echo "Source JS: $(echo "scale=1; $SRC_SIZE / 1024" | bc)KB"
echo "Minified JS: $(echo "scale=1; $DIST_SIZE / 1024" | bc)KB"
echo "Reduction: $(echo "scale=0; 100 - ($DIST_SIZE * 100 / $SRC_SIZE)" | bc)%"
echo ""

VERSION=$(grep '"version"' "$DIST/manifest.json" | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/')
ZIP_NAME="lensed-extension-v${VERSION}.zip"
ZIP_PATH="$SCRIPT_DIR/$ZIP_NAME"

rm -f "$ZIP_PATH"
cd "$DIST"
zip -r "$ZIP_PATH" . -x '.DS_Store' 2>/dev/null
cd "$SCRIPT_DIR"

ZIP_SIZE=$(ls -lh "$ZIP_PATH" | awk '{print $5}')
FILE_COUNT=$(unzip -l "$ZIP_PATH" 2>/dev/null | tail -1 | awk '{print $2}')

echo "ZIP: $ZIP_NAME ($ZIP_SIZE, $FILE_COUNT files)"
echo "Path: $ZIP_PATH"
echo ""
echo "Done."
