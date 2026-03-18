/**
 * WasmEngine.ts
 *
 * Bridges TresJS Float32Array vertex data with the C++ geometry functions
 * compiled to WebAssembly.
 *
 * Usage
 * -----
 *   const engine = await WasmEngine.create();
 *
 *   // Legacy single-axis scale:
 *   const scaledY = engine.scaleVerticesY(vertices, 1.5);
 *
 *   // Full XYZ scale:
 *   const scaledXYZ = engine.scaleVertices(vertices, 1.0, 2.0, 0.5);
 *
 *   engine.dispose();   // optional; safe to reuse the same instance
 */

// ── Type shim for the Emscripten-generated module ────────────────────────────
interface EmscriptenModule {
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  /** Legacy single-axis Y scaler. */
  _scaleVerticesY(ptr: number, length: number, scale: number): void;
  /** Full XYZ scaler. */
  _scaleVertices(
    ptr: number,
    length: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
  ): void;
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
    await WasmEngine.injectScript("/geometry.js");

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

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * (Legacy) Multiplies every Y coordinate in the vertex array by `scale`.
   *
   * @param vertices  Flat [x, y, z, x, y, z, …] Float32Array from TresJS
   * @param scale     Scale factor for Y components
   * @returns         A new Float32Array with the modified vertices
   */
  scaleVerticesY(vertices: Float32Array, scale: number): Float32Array {
    return this._callWasm((ptr, count) => {
      this.mod._scaleVerticesY(ptr, count, scale);
    }, vertices);
  }

  /**
   * Multiplies each vertex component by its own scale factor.
   *
   * @param vertices  Flat [x, y, z, x, y, z, …] Float32Array from TresJS
   * @param scaleX    Scale factor for X components
   * @param scaleY    Scale factor for Y components
   * @param scaleZ    Scale factor for Z components
   * @returns         A new Float32Array with the modified vertices
   */
  scaleVertices(
    vertices: Float32Array,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
  ): Float32Array {
    // ── Fast path: use the compiled C++ function ────────────────────────────
    if (typeof this.mod._scaleVertices === "function") {
      return this._callWasm((ptr, count) => {
        this.mod._scaleVertices(ptr, count, scaleX, scaleY, scaleZ);
      }, vertices);
    }

    // ── Fallback: pure JS until the Wasm binary is recompiled ───────────────
    console.warn(
      "[WasmEngine] _scaleVertices not found in Wasm binary — using JS " +
        "fallback. Recompile geometry.cpp with _scaleVertices in EXPORTED_FUNCTIONS.",
    );
    const out = vertices.slice(); // copy so we don't mutate the source
    for (let i = 0; i < out.length; i += 3) {
      out[i] *= scaleX;
      out[i + 1] *= scaleY;
      out[i + 2] *= scaleZ;
    }
    return out;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Generic helper: copies `vertices` onto the Wasm heap, runs `fn`, and
   * returns the mutated data as a fresh Float32Array.
   */
  private _callWasm(
    fn: (ptr: number, elementCount: number) => void,
    vertices: Float32Array,
  ): Float32Array {
    const { _malloc, _free, HEAPF32 } = this.mod;

    const byteLength = vertices.byteLength;
    const elementCount = vertices.length;

    // 1. Allocate on the Wasm heap.
    const ptr = _malloc(byteLength);
    if (ptr === 0) {
      throw new Error("[WasmEngine] malloc failed — out of Wasm memory.");
    }

    try {
      // 2. Copy JS → Wasm (ptr is a byte offset; HEAPF32 index = ptr >> 2).
      HEAPF32.set(vertices, ptr >> 2);

      // 3. Call the C++ function via the provided closure.
      fn(ptr, elementCount);

      // 4. Read the mutated data back into a fresh JS Float32Array.
      return HEAPF32.slice(ptr >> 2, (ptr >> 2) + elementCount);
    } finally {
      // 5. Always free, even on error.
      _free(ptr);
    }
  }

  /** Injects a <script> tag and resolves when it has loaded. */
  private static injectScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
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
