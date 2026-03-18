#!/usr/bin/env bash
# build-wasm.sh
#
# Compiles the geometry helper and binary STL parser into WebAssembly modules.

set -euo pipefail

OUT_DIR="public"
TEMP_DIR=".wasm-tmp"

mkdir -p "$OUT_DIR"
mkdir -p "$TEMP_DIR"

emcc "src/math/geometry.cpp" \
  -O2 \
  -o "$TEMP_DIR/geometry.js" \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME="GeometryModule" \
  -s EXPORTED_FUNCTIONS='["_scaleVerticesY", "_scaleVertices", "_scaleVerticesWithAnalytics", "_malloc", "_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall", "cwrap", "HEAPF32"]' \
  -s ALLOW_MEMORY_GROWTH=1

emcc "src/math/stl_parser.cpp" \
  -O3 \
  -o "$TEMP_DIR/stl_parser.wasm" \
  --no-entry \
  -s STANDALONE_WASM=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=134217728 \
  -s MAXIMUM_MEMORY=2147483648 \
  -s EXPORTED_FUNCTIONS='["_getBinaryStlFloatCount", "_parseBinaryStl", "_malloc", "_free"]'

mv -f "$TEMP_DIR/geometry.js" "$OUT_DIR/geometry.js"
mv -f "$TEMP_DIR/geometry.wasm" "$OUT_DIR/geometry.wasm"
mv -f "$TEMP_DIR/stl_parser.wasm" "$OUT_DIR/stl_parser.wasm"

rmdir "$TEMP_DIR"

echo "Wasm build complete -> $OUT_DIR/geometry.wasm, $OUT_DIR/geometry.js, and $OUT_DIR/stl_parser.wasm"
