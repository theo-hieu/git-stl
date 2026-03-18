/**
 * geometry.cpp
 *
 * C++ math engine for WebAssembly.
 *
 * Exports:
 *   scaleVerticesY  — legacy single-axis Y scaler (kept for compatibility)
 *   scaleVertices   — full XYZ scaler (new)
 *
 * Both functions operate in-place on a flat Float32Array laid out as
 * [x0, y0, z0, x1, y1, z1, ...].
 *
 * Compile with Emscripten (see build-wasm.sh).
 */

#include <cstddef> // size_t

extern "C" {

/**
 * Legacy: multiplies every Y component by `scale`.
 *
 * @param vertices  Pointer to a flat float array [x,y,z, x,y,z, ...]
 * @param length    Total number of floats (vertex_count * 3)
 * @param scale     Multiplier applied to every Y component
 */
void scaleVerticesY(float *vertices, int length, float scale) {
  for (int i = 1; i < length; i += 3) {
    vertices[i] *= scale;
  }
}

/**
 * Full XYZ scale: multiplies each component by its own scale factor.
 *
 * @param vertices  Pointer to a flat float array [x,y,z, x,y,z, ...]
 * @param length    Total number of floats (vertex_count * 3)
 * @param scaleX    Multiplier applied to every X component (index 0, 3, 6, …)
 * @param scaleY    Multiplier applied to every Y component (index 1, 4, 7, …)
 * @param scaleZ    Multiplier applied to every Z component (index 2, 5, 8, …)
 *
 * The array is mutated in-place; the caller reads the result back
 * from the same Wasm heap memory.
 */
void scaleVertices(float *vertices, int length, float scaleX, float scaleY,
                   float scaleZ) {
  for (int i = 0; i < length; i += 3) {
    vertices[i] *= scaleX;
    vertices[i + 1] *= scaleY;
    vertices[i + 2] *= scaleZ;
  }
}

} // extern "C"
