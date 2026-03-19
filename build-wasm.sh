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
  -std=c++17 \
  -O2 \
  -o "$TEMP_DIR/geometry.wasm" \
  --no-entry \
  -s STANDALONE_WASM=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=16777216 \
  -s MAXIMUM_MEMORY=2147483648 \
  -s EXPORTED_FUNCTIONS='["_scaleVerticesY", "_scaleVertices", "_scaleVerticesWithAnalytics", "_malloc", "_free"]'

emcc "src/math/stl_parser.cpp" \
  -std=c++17 \
  -O3 \
  -o "$TEMP_DIR/stl_parser.wasm" \
  --no-entry \
  -s STANDALONE_WASM=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=268435456 \
  -s MAXIMUM_MEMORY=2147483648 \
  -s EXPORTED_FUNCTIONS='["_getStlFloatCount", "_parseStl", "_getBinaryStlFloatCount", "_parseBinaryStl", "_getParsedStlPositions", "_getParsedStlNormals", "_getParsedStlFloatCount", "_freeParsedStl", "_malloc", "_free"]'

mv -f "$TEMP_DIR/geometry.wasm" "$OUT_DIR/geometry.wasm"
mv -f "$TEMP_DIR/stl_parser.wasm" "$OUT_DIR/stl_parser.wasm"

rmdir "$TEMP_DIR"

echo "Wasm build complete -> $OUT_DIR/geometry.wasm and $OUT_DIR/stl_parser.wasm"
