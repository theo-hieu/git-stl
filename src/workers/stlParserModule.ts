export interface StlParserModule {
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _getBinaryStlFloatCount(dataPtr: number, length: number): number;
  _parseBinaryStl(dataPtr: number, length: number): number;
  readonly HEAPU8: Uint8Array;
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
  _getBinaryStlFloatCount?: NumericFn;
  getBinaryStlFloatCount?: NumericFn;
  _parseBinaryStl?: NumericFn;
  parseBinaryStl?: NumericFn;
};

function getFunction(
  exports: WasmExports,
  names: string[],
): NumericFn {
  for (const name of names) {
    const candidate = exports[name as keyof WasmExports];
    if (typeof candidate === "function") {
      return candidate as NumericFn;
    }
  }

  throw new Error(`Missing Wasm export: ${names.join(" or ")}`);
}

async function instantiateParserWasm(): Promise<WasmExports> {
  const wasmUrl = new URL("/stl_parser.wasm", self.location.origin).href;
  const response = await fetch(wasmUrl);
  const imports = {
    env: {
      emscripten_notify_memory_growth: () => {},
    },
  };

  if (!response.ok) {
    throw new Error(`Failed to fetch STL parser Wasm: ${response.status}`);
  }

  if ("instantiateStreaming" in WebAssembly) {
    const { instance } = await WebAssembly.instantiateStreaming(response, imports);
    return instance.exports as WasmExports;
  }

  const bytes = await response.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance.exports as WasmExports;
}

export async function createStlParserModule(): Promise<StlParserModule> {
  const exports = await instantiateParserWasm();
  exports._initialize?.();
  const memory = exports.memory;

  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error("STL parser Wasm does not export linear memory.");
  }

  let heapU8 = new Uint8Array(memory.buffer);
  let heapF32 = new Float32Array(memory.buffer);

  const refreshViews = () => {
    if (heapU8.buffer !== memory.buffer) {
      heapU8 = new Uint8Array(memory.buffer);
      heapF32 = new Float32Array(memory.buffer);
    }
  };

  const malloc = getFunction(exports, ["_malloc", "malloc"]);
  const free = getFunction(exports, ["_free", "free"]);
  const getBinaryStlFloatCount = getFunction(exports, [
    "_getBinaryStlFloatCount",
    "getBinaryStlFloatCount",
  ]);
  const parseBinaryStl = getFunction(exports, [
    "_parseBinaryStl",
    "parseBinaryStl",
  ]);

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
    _getBinaryStlFloatCount(dataPtr: number, length: number) {
      refreshViews();
      return getBinaryStlFloatCount(dataPtr, length);
    },
    _parseBinaryStl(dataPtr: number, length: number) {
      refreshViews();
      const ptr = parseBinaryStl(dataPtr, length);
      refreshViews();
      return ptr;
    },
    get HEAPU8() {
      refreshViews();
      return heapU8;
    },
    get HEAPF32() {
      refreshViews();
      return heapF32;
    },
  };
}
