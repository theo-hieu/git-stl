/**
 * WasmEngine.ts
 *
 * Utility class that bridges our TresJS Float32Array vertex data
 * with the C++ scaleVerticesY function compiled to WebAssembly.
 *
 * Usage
 * -----
 *   const engine = await WasmEngine.create();
 *   const scaled = engine.scaleVerticesY(myFloat32Array, 2.0);
 *   engine.dispose();          // optional; safe to reuse the same instance
 */

// ── Type shim for the Emscripten-generated module ────────────────────────────
interface EmscriptenModule {
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _scaleVerticesY(ptr: number, length: number, scale: number): void;
  HEAPF32: Float32Array;
}

declare function GeometryModule(): Promise<EmscriptenModule>;

// ── WasmEngine ────────────────────────────────────────────────────────────────
export class WasmEngine {
  private mod: EmscriptenModule;

  /** Use WasmEngine.create() — constructor is private to enforce async init. */
  private constructor(mod: EmscriptenModule) {
    this.mod = mod;
  }

  /**
   * Loads the Wasm module and returns a ready-to-use WasmEngine instance.
   * The JS glue file (geometry.js) must be served from /public/geometry.js.
   */
  static async create(): Promise<WasmEngine> {
    // Dynamically import the Emscripten glue script.
    // Vite will not bundle it; it is served statically from /public.
    await WasmEngine.injectScript("/geometry.js");

    // The glue script exposes GeometryModule() in globalThis.
    const factory = (
      globalThis as unknown as {
        GeometryModule: () => Promise<EmscriptenModule>;
      }
    ).GeometryModule;

    if (typeof factory !== "function") {
      throw new Error(
        "[WasmEngine] GeometryModule not found — did the build-wasm.sh script run?",
      );
    }

    const mod = await factory();
    return new WasmEngine(mod);
  }

  /**
   * Multiplies every Y coordinate in the provided vertex array by `scale`.
   *
   * @param vertices  Flat [x, y, z, x, y, z, …] Float32Array from TresJS
   * @param scale     Scale factor for Y components
   * @returns         A new Float32Array with the modified vertices
   */
  scaleVerticesY(vertices: Float32Array, scale: number): Float32Array {
    const { _malloc, _free, _scaleVerticesY, HEAPF32 } = this.mod;

    const byteLength = vertices.byteLength;
    const elementCount = vertices.length;

    // 1. Allocate memory on the Wasm heap.
    const ptr = _malloc(byteLength);
    if (ptr === 0) {
      throw new Error("[WasmEngine] malloc failed — out of Wasm memory.");
    }

    try {
      // 2. Copy the JS Float32Array into Wasm heap memory.
      //    HEAPF32 is a Float32Array view of the entire Wasm linear memory.
      //    ptr is a byte offset, so we convert to a Float32 index (>> 2).
      HEAPF32.set(vertices, ptr >> 2);

      // 3. Call the C++ function.
      _scaleVerticesY(ptr, elementCount, scale);

      // 4. Read the mutated data back into a fresh JS Float32Array.
      return HEAPF32.slice(ptr >> 2, (ptr >> 2) + elementCount);
    } finally {
      // 5. Always free the heap allocation, even if an error occurred.
      _free(ptr);
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /** Injects a <script> tag and resolves when it has loaded. */
  private static injectScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Avoid double-loading.
      if (document.querySelector(`script[src="${src}"]`)) {
        resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error(`[WasmEngine] Failed to load script: ${src}`));
      document.head.appendChild(script);
    });
  }
}
