import { BufferAttribute, BufferGeometry } from "three";
import { MeshBVH, type SerializedBVH } from "three-mesh-bvh";
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
  normals: Float32Array;
  serializedBVH: SerializedBVH;
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

function getTransferablesForGeometryPayload(
  positions: Float32Array,
  normals: Float32Array,
  serializedBVH: SerializedBVH,
): Transferable[] {
  const transferables: Transferable[] = [
    positions.buffer,
    normals.buffer,
    ...serializedBVH.roots,
  ];

  if (serializedBVH.index) {
    transferables.push(serializedBVH.index.buffer);
  }

  return transferables.filter(
    (value): value is Transferable =>
      !(typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer),
  );
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

function parseBinaryStl(
  mod: StlParserModule,
  buffer: ArrayBuffer,
): { positions: Float32Array; normals: Float32Array } {
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

  let resultPtr = 0;

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
      return {
        positions: new Float32Array(),
        normals: new Float32Array(),
      };
    }

    resultPtr = mod._parseBinaryStl(inputPtr, bytes.byteLength);
    if (resultPtr === 0) {
      throw new Error("Wasm STL parser failed to allocate output buffers.");
    }

    const outputFloatCount = mod._getParsedStlFloatCount(resultPtr);
    const positionsPtr = mod._getParsedStlPositions(resultPtr);
    const normalsPtr = mod._getParsedStlNormals(resultPtr);

    if (outputFloatCount !== floatCount) {
      throw new Error("Wasm STL parser returned an unexpected output size.");
    }

    if (positionsPtr === 0 || normalsPtr === 0) {
      throw new Error("Wasm STL parser returned incomplete output buffers.");
    }

    const positionsStart = positionsPtr >> 2;
    const normalsStart = normalsPtr >> 2;

    return {
      positions: mod.HEAPF32.slice(positionsStart, positionsStart + floatCount),
      normals: mod.HEAPF32.slice(normalsStart, normalsStart + floatCount),
    };
  } finally {
    if (resultPtr !== 0) {
      mod._freeParsedStl(resultPtr);
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
    const { positions, normals } = parseBinaryStl(mod, buffer);
    const workerGeometry = new BufferGeometry();
    workerGeometry.setAttribute("position", new BufferAttribute(positions, 3));

    // MeshBVH generation is eager in the installed library version, so construction
    // here performs the full spatial index build off the main thread.
    const bvh = new MeshBVH(workerGeometry);
    const serializedBVH = MeshBVH.serialize(bvh);
    const response: StlWorkerSuccess = { id, positions, normals, serializedBVH };

    (self as DedicatedWorkerGlobalScope).postMessage(
      response,
      getTransferablesForGeometryPayload(positions, normals, serializedBVH),
    );
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
