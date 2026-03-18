export interface GeometryModule {
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
  readonly HEAPF32: Float32Array;
}

type NumericFn = (...args: number[]) => number;

type WasmExports = WebAssembly.Exports & {
  memory?: WebAssembly.Memory;
  _initialize?: () => void;
  _malloc?: NumericFn;
  malloc?: NumericFn;
  _free?: NumericFn;
  free?: NumericFn;
  _scaleVerticesY?: NumericFn;
  scaleVerticesY?: NumericFn;
  _scaleVertices?: NumericFn;
  scaleVertices?: NumericFn;
  _scaleVerticesWithAnalytics?: NumericFn;
  scaleVerticesWithAnalytics?: NumericFn;
};

function getFunction(exports: WasmExports, names: string[]): NumericFn {
  for (const name of names) {
    const candidate = exports[name as keyof WasmExports];
    if (typeof candidate === "function") {
      return candidate as NumericFn;
    }
  }

  throw new Error(`Missing geometry Wasm export: ${names.join(" or ")}`);
}

function getGeometryWasmUrl(): string {
  const baseUrl = import.meta.env.BASE_URL || "/";
  return new URL("geometry.wasm", new URL(baseUrl, window.location.href)).href;
}

async function instantiateGeometryWasm(): Promise<WasmExports> {
  let memory: WebAssembly.Memory | null = null;
  const response = await fetch(getGeometryWasmUrl());
  const imports = {
    env: {
      emscripten_notify_memory_growth: () => {},
      emscripten_resize_heap(requestedSize: number) {
        if (!(memory instanceof WebAssembly.Memory)) {
          return 0;
        }

        const currentSize = memory.buffer.byteLength;
        if (requestedSize <= currentSize) {
          return 1;
        }

        const additionalBytes = requestedSize - currentSize;
        const pageSize = 64 * 1024;
        const additionalPages = Math.ceil(additionalBytes / pageSize);

        try {
          memory.grow(additionalPages);
          return 1;
        } catch {
          return 0;
        }
      },
    },
  };

  if (!response.ok) {
    throw new Error(`Failed to fetch geometry Wasm: ${response.status}`);
  }

  if ("instantiateStreaming" in WebAssembly) {
    const { instance } = await WebAssembly.instantiateStreaming(response, imports);
    memory =
      instance.exports.memory instanceof WebAssembly.Memory
        ? instance.exports.memory
        : null;
    return instance.exports as WasmExports;
  }

  const bytes = await response.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  memory =
    instance.exports.memory instanceof WebAssembly.Memory
      ? instance.exports.memory
      : null;
  return instance.exports as WasmExports;
}

export async function createGeometryModule(): Promise<GeometryModule> {
  const exports = await instantiateGeometryWasm();
  exports._initialize?.();
  const memory = exports.memory;

  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error("Geometry Wasm does not export linear memory.");
  }

  let heapF32 = new Float32Array(memory.buffer);

  const refreshViews = () => {
    if (heapF32.buffer !== memory.buffer) {
      heapF32 = new Float32Array(memory.buffer);
    }
  };

  const malloc = getFunction(exports, ["_malloc", "malloc"]);
  const free = getFunction(exports, ["_free", "free"]);
  const scaleVerticesY = getFunction(exports, [
    "_scaleVerticesY",
    "scaleVerticesY",
  ]);
  const scaleVertices = getFunction(exports, [
    "_scaleVertices",
    "scaleVertices",
  ]);
  const scaleVerticesWithAnalytics = (() => {
    try {
      return getFunction(exports, [
        "_scaleVerticesWithAnalytics",
        "scaleVerticesWithAnalytics",
      ]);
    } catch {
      return null;
    }
  })();

  return {
    _malloc(bytes: number) {
      refreshViews();
      const ptr = malloc(bytes);
      refreshViews();
      return ptr;
    },
    _free(ptr: number) {
      refreshViews();
      free(ptr);
      refreshViews();
    },
    _scaleVerticesY(ptr: number, length: number, scale: number) {
      refreshViews();
      scaleVerticesY(ptr, length, scale);
      refreshViews();
    },
    _scaleVertices(
      ptr: number,
      length: number,
      scaleX: number,
      scaleY: number,
      scaleZ: number,
    ) {
      refreshViews();
      scaleVertices(ptr, length, scaleX, scaleY, scaleZ);
      refreshViews();
    },
    _scaleVerticesWithAnalytics(
      ptr: number,
      length: number,
      scaleX: number,
      scaleY: number,
      scaleZ: number,
      analyticsPtr: number,
    ) {
      if (!scaleVerticesWithAnalytics) {
        throw new Error("Geometry Wasm does not export scaleVerticesWithAnalytics.");
      }

      refreshViews();
      scaleVerticesWithAnalytics(ptr, length, scaleX, scaleY, scaleZ, analyticsPtr);
      refreshViews();
    },
    get HEAPF32() {
      refreshViews();
      return heapF32;
    },
  };
}
