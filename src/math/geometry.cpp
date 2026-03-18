/**
 * geometry.cpp
 *
 * Proof-of-concept C++ math engine for WebAssembly.
 * Exposes scaleVerticesY — scales the Y coordinate of every vertex
 * in a flat Float32Array laid out as [x, y, z, x, y, z, ...].
 *
 * Compile with build-wasm.sh (Emscripten / emcc).
 */

#include <cstddef>  // size_t

extern "C" {

/**
 * @param vertices  Pointer to a flat float array [x0,y0,z0, x1,y1,z1, ...]
 * @param length    Total number of floats  (vertex_count * 3)
 * @param scale     Multiplier applied to every Y component
 *
 * The array is mutated in-place; the caller reads the result back
 * from the same Wasm heap memory.
 */
void scaleVerticesY(float* vertices, int length, float scale) {
    // Every third element starting at index 1 is a Y coordinate.
    for (int i = 1; i < length; i += 3) {
        vertices[i] *= scale;
    }
}

} // extern "C"
