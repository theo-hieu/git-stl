import { BufferGeometry } from "three";

/**
 * Extracts the vertex data from a Three.js BufferGeometry.
 * This prepares the raw vertex data for future WebAssembly C++ operations.
 *
 * @param geometry The BufferGeometry to extract vertices from
 * @returns A Float32Array containing the flat (x,y,z) vertex coordinates
 */
export function extractVertices(geometry: BufferGeometry): Float32Array {
  const positionAttribute = geometry.getAttribute("position");

  if (!positionAttribute) {
    throw new Error("Geometry does not have a position attribute");
  }

  if (positionAttribute.array instanceof Float32Array) {
    // If it's already a continuous Float32Array, we can return a copy or the array itself.
    // Returning a copy is often safer for Wasm memory operations to avoid unintended mutations.
    return new Float32Array(positionAttribute.array);
  }

  // Fallback if the data is not a simple Float32Array (e.g. interleaved or different type)
  const vertices = new Float32Array(
    positionAttribute.count * positionAttribute.itemSize,
  );
  for (let i = 0; i < positionAttribute.count; i++) {
    for (let j = 0; j < positionAttribute.itemSize; j++) {
      vertices[i * positionAttribute.itemSize + j] =
        positionAttribute.getComponent(i, j);
    }
  }

  return vertices;
}
