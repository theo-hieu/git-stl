import type { StlParserModule } from "./stlParserModule";

let modulePromise: Promise<StlParserModule> | null = null;

async function getParserModule(): Promise<StlParserModule> {
  if (modulePromise === null) {
    modulePromise = import("./stlParserModule").then(({ createStlParserModule }) =>
      createStlParserModule(),
    );
  }

  return modulePromise;
}

function parseBinaryStl(
  mod: StlParserModule,
  buffer: ArrayBuffer,
): Float32Array {
  const bytes = new Uint8Array(buffer);
  const inputPtr = mod._malloc(bytes.byteLength);
  if (inputPtr === 0) {
    throw new Error("Failed to allocate Wasm input buffer.");
  }

  let outputPtr = 0;

  try {
    mod.HEAPU8.set(bytes, inputPtr);

    const floatCount = mod._getBinaryStlFloatCount(inputPtr, bytes.byteLength);
    if (floatCount < 0) {
      throw new Error("Invalid or truncated binary STL payload.");
    }

    if (floatCount === 0) {
      return new Float32Array();
    }

    outputPtr = mod._parseBinaryStl(inputPtr, bytes.byteLength);
    if (outputPtr === 0) {
      throw new Error("Wasm STL parser failed to allocate output vertices.");
    }

    const start = outputPtr >> 2;
    return mod.HEAPF32.slice(start, start + floatCount);
  } finally {
    if (outputPtr !== 0) {
      mod._free(outputPtr);
    }
    mod._free(inputPtr);
  }
}

self.onmessage = async (
  event: MessageEvent<{ id: number; buffer: ArrayBuffer }>,
) => {
  const { id, buffer } = event.data;

  try {
    const mod = await getParserModule();
    const positions = parseBinaryStl(mod, buffer);

    (self as DedicatedWorkerGlobalScope).postMessage(
      { id, positions },
      [positions.buffer],
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ id, error: message });
  }
};
