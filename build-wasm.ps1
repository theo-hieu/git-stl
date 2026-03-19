$ErrorActionPreference = "Stop"

$OUT_DIR = "public"
$TEMP_DIR = ".wasm-tmp"

New-Item -ItemType Directory -Force -Path $OUT_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $TEMP_DIR | Out-Null

emcc "src/math/geometry.cpp" `
  -std=c++17 `
  -O2 `
  -o "$TEMP_DIR/geometry.wasm" `
  --no-entry `
  -s STANDALONE_WASM=1 `
  -s ALLOW_MEMORY_GROWTH=1 `
  -s INITIAL_MEMORY=16777216 `
  -s MAXIMUM_MEMORY=2147483648 `
  -s EXPORTED_FUNCTIONS='["_scaleVerticesY", "_scaleVertices", "_scaleVerticesWithAnalytics", "_malloc", "_free"]'
if ($LASTEXITCODE -ne 0) { throw "geometry.cpp Wasm build failed." }

emcc "src/math/stl_parser.cpp" `
  -std=c++17 `
  -O3 `
  -o "$TEMP_DIR/stl_parser.wasm" `
  --no-entry `
  -s STANDALONE_WASM=1 `
  -s ALLOW_MEMORY_GROWTH=1 `
  -s INITIAL_MEMORY=268435456 `
  -s MAXIMUM_MEMORY=2147483648 `
  -s EXPORTED_FUNCTIONS='["_getStlFloatCount", "_parseStl", "_getBinaryStlFloatCount", "_parseBinaryStl", "_getParsedStlPositions", "_getParsedStlNormals", "_getParsedStlFloatCount", "_freeParsedStl", "_malloc", "_free"]'
if ($LASTEXITCODE -ne 0) { throw "stl_parser.cpp Wasm build failed." }

Move-Item -Force "$TEMP_DIR/geometry.wasm" "$OUT_DIR/geometry.wasm"
Move-Item -Force "$TEMP_DIR/stl_parser.wasm" "$OUT_DIR/stl_parser.wasm"

Remove-Item -Force -Recurse $TEMP_DIR

Write-Host "Wasm build complete -> $OUT_DIR/geometry.wasm and $OUT_DIR/stl_parser.wasm"
