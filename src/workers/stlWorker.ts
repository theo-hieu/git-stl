import type { StlParserModule } from "./stlParserModule";

const ASCII_STL_FLOAT_COUNT = -2;
const ASCII_STL_ERROR_CODE = "ascii_stl_unsupported";

let modulePromise: Promise<StlParserModule> | null = null;

class StlParserError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

interface StlWorkerSuccess {
  id: number;
  positions: Float32Array;
}

interface StlWorkerFailure {
  id: number;
  error: string;
  errorCode?: string;
}

async function getParserModule(): Promise<StlParserModule> {
  if (modulePromise === null) {
    modulePromise = import("./stlParserModule").then(({ createStlParserModule }) =>
      createStlParserModule(),
    );
  }

  return modulePromise;
}

function lowerAscii(byte: number): string {
  return String.fromCharCode(byte).toLowerCase();
}

function looksLikeAsciiStl(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 5) {
    return false;
  }

  let offset = 0;
  while (offset < bytes.length && /\s/.test(String.fromCharCode(bytes[offset]))) {
    offset += 1;
  }

  if (offset + 5 > bytes.length) {
    return false;
  }

  const startsWithSolid =
    lowerAscii(bytes[offset]) === "s" &&
    lowerAscii(bytes[offset + 1]) === "o" &&
    lowerAscii(bytes[offset + 2]) === "l" &&
    lowerAscii(bytes[offset + 3]) === "i" &&
    lowerAscii(bytes[offset + 4]) === "d";

  if (!startsWithSolid) {
    return false;
  }

  const scanLimit = Math.min(bytes.length, 512);
  const headerText = new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.slice(0, scanLimit),
  );

  return /facet\s+normal/i.test(headerText);
}

function parseBinaryStl(mod: StlParserModule, buffer: ArrayBuffer): Float32Array {
  if (looksLikeAsciiStl(buffer)) {
    throw new StlParserError(
      "ASCII STL detected. Import a binary STL or add an ASCII parser path.",
      ASCII_STL_ERROR_CODE,
    );
  }

  const bytes = new Uint8Array(buffer);
  const inputPtr = mod._malloc(bytes.byteLength);
  if (inputPtr === 0) {
    throw new Error("Failed to allocate Wasm input buffer.");
  }

  let outputPtr = 0;

  try {
    mod.HEAPU8.set(bytes, inputPtr);

    const floatCount = mod._getBinaryStlFloatCount(inputPtr, bytes.byteLength);
    if (floatCount === ASCII_STL_FLOAT_COUNT) {
      throw new StlParserError(
        "ASCII STL detected. Import a binary STL or add an ASCII parser path.",
        ASCII_STL_ERROR_CODE,
      );
    }

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
    const response: StlWorkerSuccess = { id, positions };

    (self as DedicatedWorkerGlobalScope).postMessage(response, [positions.buffer]);
  } catch (error) {
    const failure: StlWorkerFailure =
      error instanceof StlParserError
        ? { id, error: error.message, errorCode: error.code }
        : {
            id,
            error: error instanceof Error ? error.message : String(error),
          };

    self.postMessage(failure);
  }
};
