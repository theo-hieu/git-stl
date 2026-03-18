interface EmscriptenModule {
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _scaleVerticesY(ptr: number, length: number, scale: number): void;
  _scaleVertices(
    ptr: number,
    length: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
  ): void;
  _scaleVerticesWithAnalytics?(
    ptr: number,
    length: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
    analyticsPtr: number,
  ): void;
  HEAPF32: Float32Array;
}

export interface GeometryBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface ScaledGeometryResult {
  vertices: Float32Array;
  boundingBox: GeometryBounds;
  volume: number;
}

const ANALYTICS_FLOAT_COUNT = 7;

export class WasmEngine {
  private static scriptPromise: Promise<void> | null = null;
  private static modulePromise: Promise<EmscriptenModule> | null = null;

  private constructor(private readonly mod: EmscriptenModule) {}

  static async create(): Promise<WasmEngine> {
    const mod = await WasmEngine.loadModule();
    return new WasmEngine(mod);
  }

  scaleVerticesY(vertices: Float32Array, scale: number): Float32Array {
    return this.callWithHeapBuffers({
      vertices,
      outputFloatCount: 0,
      invoke: ({ inputPtr, elementCount }) => {
        this.mod._scaleVerticesY(inputPtr, elementCount, scale);
      },
      readResult: ({ inputPtr, elementCount, heapF32 }) =>
        heapF32.slice(inputPtr >> 2, (inputPtr >> 2) + elementCount),
    });
  }

  scaleVertices(
    vertices: Float32Array,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
  ): ScaledGeometryResult {
    if (typeof this.mod._scaleVerticesWithAnalytics === "function") {
      return this.callWithHeapBuffers({
        vertices,
        outputFloatCount: ANALYTICS_FLOAT_COUNT,
        invoke: ({ inputPtr, outputPtr, elementCount }) => {
          if (outputPtr === 0) {
            throw new Error("[WasmEngine] analytics buffer allocation failed.");
          }

          this.mod._scaleVerticesWithAnalytics?.(
            inputPtr,
            elementCount,
            scaleX,
            scaleY,
            scaleZ,
            outputPtr,
          );
        },
        readResult: ({ inputPtr, outputPtr, elementCount, heapF32 }) => {
          if (outputPtr === 0) {
            throw new Error("[WasmEngine] analytics buffer allocation failed.");
          }

          const scaledVertices = heapF32.slice(
            inputPtr >> 2,
            (inputPtr >> 2) + elementCount,
          );
          const analytics = heapF32.slice(
            outputPtr >> 2,
            (outputPtr >> 2) + ANALYTICS_FLOAT_COUNT,
          );

          return createScaledGeometryResult(scaledVertices, analytics);
        },
      });
    }

    const scaledVertices = this.scaleVerticesWithFallback(
      vertices,
      scaleX,
      scaleY,
      scaleZ,
    );
    return createScaledGeometryResult(
      scaledVertices,
      calculateAnalyticsArray(scaledVertices),
    );
  }

  private static async loadModule(): Promise<EmscriptenModule> {
    if (!WasmEngine.modulePromise) {
      WasmEngine.modulePromise = (async () => {
        await WasmEngine.injectScript("/geometry.js");
        const factory = (
          globalThis as {
            GeometryModule?: () => Promise<EmscriptenModule>;
          }
        ).GeometryModule;

        if (typeof factory !== "function") {
          throw new Error(
            "[WasmEngine] GeometryModule not found. Rebuild the Wasm artifacts in public/.",
          );
        }

        return factory();
      })();
    }

    return WasmEngine.modulePromise;
  }

  private callWithHeapBuffers<T>({
    vertices,
    outputFloatCount,
    invoke,
    readResult,
  }: HeapCallConfig<T>): T {
    const inputPtr = this.mod._malloc(vertices.byteLength);
    if (inputPtr === 0) {
      throw new Error("[WasmEngine] malloc failed for the input vertex buffer.");
    }

    const outputPtr =
      outputFloatCount > 0
        ? this.mod._malloc(outputFloatCount * Float32Array.BYTES_PER_ELEMENT)
        : 0;

    if (outputFloatCount > 0 && outputPtr === 0) {
      this.mod._free(inputPtr);
      throw new Error("[WasmEngine] malloc failed for the output analytics buffer.");
    }

    try {
      this.mod.HEAPF32.set(vertices, inputPtr >> 2);
      invoke({
        elementCount: vertices.length,
        inputPtr,
        outputPtr,
      });

      return readResult({
        elementCount: vertices.length,
        heapF32: this.mod.HEAPF32,
        inputPtr,
        outputPtr,
      });
    } finally {
      if (outputPtr !== 0) {
        this.mod._free(outputPtr);
      }

      this.mod._free(inputPtr);
    }
  }

  private scaleVerticesWithFallback(
    vertices: Float32Array,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
  ): Float32Array {
    if (typeof this.mod._scaleVertices === "function") {
      return this.callWithHeapBuffers({
        vertices,
        outputFloatCount: 0,
        invoke: ({ inputPtr, elementCount }) => {
          this.mod._scaleVertices(inputPtr, elementCount, scaleX, scaleY, scaleZ);
        },
        readResult: ({ inputPtr, elementCount, heapF32 }) =>
          heapF32.slice(inputPtr >> 2, (inputPtr >> 2) + elementCount),
      });
    }

    const scaled = vertices.slice();
    for (let index = 0; index < scaled.length; index += 3) {
      scaled[index] *= scaleX;
      scaled[index + 1] *= scaleY;
      scaled[index + 2] *= scaleZ;
    }

    return scaled;
  }

  private static injectScript(src: string): Promise<void> {
    if (!WasmEngine.scriptPromise) {
      WasmEngine.scriptPromise = new Promise((resolve, reject) => {
        const existing = document.querySelector<HTMLScriptElement>(
          `script[src="${src}"]`,
        );
        if (existing) {
          if (existing.dataset.loaded === "true") {
            resolve();
            return;
          }

          existing.addEventListener("load", () => resolve(), { once: true });
          existing.addEventListener(
            "error",
            () => reject(new Error(`[WasmEngine] Failed to load script: ${src}`)),
            { once: true },
          );
          return;
        }

        const script = document.createElement("script");
        script.src = src;
        script.async = true;
        script.onload = () => {
          script.dataset.loaded = "true";
          resolve();
        };
        script.onerror = () =>
          reject(new Error(`[WasmEngine] Failed to load script: ${src}`));
        document.head.appendChild(script);
      });
    }

    return WasmEngine.scriptPromise;
  }
}

interface HeapCallConfig<T> {
  vertices: Float32Array;
  outputFloatCount: number;
  invoke(context: HeapInvokeContext): void;
  readResult(context: HeapReadContext): T;
}

interface HeapInvokeContext {
  elementCount: number;
  inputPtr: number;
  outputPtr: number;
}

interface HeapReadContext extends HeapInvokeContext {
  heapF32: Float32Array;
}

function calculateAnalyticsArray(vertices: Float32Array): Float32Array {
  if (vertices.length === 0) {
    return new Float32Array(ANALYTICS_FLOAT_COUNT);
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < vertices.length; index += 3) {
    const x = vertices[index];
    const y = vertices[index + 1];
    const z = vertices[index + 2];

    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  let signedVolume = 0;
  for (let index = 0; index + 8 < vertices.length; index += 9) {
    const ax = vertices[index];
    const ay = vertices[index + 1];
    const az = vertices[index + 2];
    const bx = vertices[index + 3];
    const by = vertices[index + 4];
    const bz = vertices[index + 5];
    const cx = vertices[index + 6];
    const cy = vertices[index + 7];
    const cz = vertices[index + 8];

    signedVolume +=
      (ax * (by * cz - bz * cy) -
        ay * (bx * cz - bz * cx) +
        az * (bx * cy - by * cx)) /
      6;
  }

  return new Float32Array([
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    Math.abs(signedVolume),
  ]);
}

function createScaledGeometryResult(
  vertices: Float32Array,
  analytics: Float32Array,
): ScaledGeometryResult {
  return {
    vertices,
    boundingBox: {
      min: [analytics[0] ?? 0, analytics[1] ?? 0, analytics[2] ?? 0],
      max: [analytics[3] ?? 0, analytics[4] ?? 0, analytics[5] ?? 0],
    },
    volume: analytics[6] ?? 0,
  };
}
