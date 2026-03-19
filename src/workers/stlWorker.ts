import { BufferAttribute, BufferGeometry } from "three";
import { Brush, Evaluator, INTERSECTION, REVERSE_SUBTRACTION, SUBTRACTION } from "three-bvh-csg";
import { MeshBVH, type SerializedBVH } from "three-mesh-bvh";
import type { StlParserModule } from "./stlParserModule";

let modulePromise: Promise<StlParserModule> | null = null;

class StlParserError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

interface FlatGeometryPayload {
  positions: Float32Array;
  normals: Float32Array;
}

interface ParseStlRequest {
  id: number;
  type: "PARSE_STL";
  buffer: ArrayBuffer;
}

interface ComputeDiffRequest {
  id: number;
  type: "COMPUTE_DIFF";
  oldBuffer: ArrayBuffer | null;
  newBuffer: ArrayBuffer | null;
}

type StlWorkerRequest = ParseStlRequest | ComputeDiffRequest;

interface ParseStlWorkerSuccess {
  id: number;
  type: "PARSE_STL_RESULT";
  positions: Float32Array;
  normals: Float32Array;
  serializedBVH: SerializedBVH;
}

interface ComputeDiffWorkerSuccess {
  id: number;
  type: "COMPUTE_DIFF_RESULT";
  oldGeometry: FlatGeometryPayload | null;
  newGeometry: FlatGeometryPayload | null;
  csgAdded: FlatGeometryPayload | null;
  csgRemoved: FlatGeometryPayload | null;
  csgUnchanged: FlatGeometryPayload | null;
}

interface StlWorkerFailure {
  id: number;
  type: "ERROR";
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

function getTransferablesForFlatGeometry(payload: FlatGeometryPayload | null): Transferable[] {
  if (!payload) {
    return [];
  }

  const transferables: Transferable[] = [];

  if (
    !(typeof SharedArrayBuffer !== "undefined" &&
      payload.positions.buffer instanceof SharedArrayBuffer)
  ) {
    transferables.push(payload.positions.buffer);
  }

  if (
    !(typeof SharedArrayBuffer !== "undefined" &&
      payload.normals.buffer instanceof SharedArrayBuffer)
  ) {
    transferables.push(payload.normals.buffer);
  }

  return transferables;
}

function parseStl(
  mod: StlParserModule,
  buffer: ArrayBuffer,
): { positions: Float32Array; normals: Float32Array } {
  const bytes = new Uint8Array(buffer);
  const inputPtr = mod._malloc(bytes.byteLength);
  if (inputPtr === 0) {
    throw new Error("Failed to allocate Wasm input buffer.");
  }

  let resultPtr = 0;

  try {
    mod.HEAPU8.set(bytes, inputPtr);
    resultPtr = mod._parseStl(inputPtr, bytes.byteLength);
    if (resultPtr === 0) {
      throw new StlParserError("Invalid, truncated, or unsupported STL payload.");
    }

    const outputFloatCount = mod._getParsedStlFloatCount(resultPtr);
    const positionsPtr = mod._getParsedStlPositions(resultPtr);
    const normalsPtr = mod._getParsedStlNormals(resultPtr);

    if (outputFloatCount === 0) {
      return {
        positions: new Float32Array(),
        normals: new Float32Array(),
      };
    }

    if (positionsPtr === 0 || normalsPtr === 0) {
      throw new Error("Wasm STL parser returned incomplete output buffers.");
    }

    const positionsStart = positionsPtr >> 2;
    const normalsStart = normalsPtr >> 2;

    return {
      positions: mod.HEAPF32.slice(
        positionsStart,
        positionsStart + outputFloatCount,
      ),
      normals: mod.HEAPF32.slice(normalsStart, normalsStart + outputFloatCount),
    };
  } finally {
    if (resultPtr !== 0) {
      mod._freeParsedStl(resultPtr);
    }

    mod._free(inputPtr);
  }
}

function buildGeometry(
  positions: Float32Array,
  normals: Float32Array,
): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(normals, 3));
  return geometry;
}

function geometryToPayload(geometry: BufferGeometry | null): FlatGeometryPayload | null {
  if (!geometry) {
    return null;
  }

  const preparedGeometry = geometry.index ? geometry.toNonIndexed() : geometry;

  try {
    const positionAttribute = preparedGeometry.getAttribute("position");
    if (!positionAttribute || positionAttribute.count === 0) {
      return null;
    }

    if (!preparedGeometry.getAttribute("normal")) {
      preparedGeometry.computeVertexNormals();
    }

    const normalAttribute = preparedGeometry.getAttribute("normal");
    if (!normalAttribute) {
      return null;
    }

    const positionsArray = positionAttribute.array;
    const normalsArray = normalAttribute.array;

    return {
      positions:
        positionsArray instanceof Float32Array
          ? positionsArray.slice()
          : Float32Array.from(positionsArray as ArrayLike<number>),
      normals:
        normalsArray instanceof Float32Array
          ? normalsArray.slice()
          : Float32Array.from(normalsArray as ArrayLike<number>),
    };
  } finally {
    if (preparedGeometry !== geometry) {
      preparedGeometry.dispose();
    }
  }
}

function computeDiffPayload(
  oldGeometry: BufferGeometry | null,
  newGeometry: BufferGeometry | null,
): Omit<ComputeDiffWorkerSuccess, "id" | "type"> {
  if (!oldGeometry || !newGeometry) {
    return {
      oldGeometry: geometryToPayload(oldGeometry),
      newGeometry: geometryToPayload(newGeometry),
      csgAdded: null,
      csgRemoved: null,
      csgUnchanged: null,
    };
  }

  const oldBrush = new Brush(oldGeometry);
  const newBrush = new Brush(newGeometry);
  oldBrush.updateMatrixWorld(true);
  newBrush.updateMatrixWorld(true);

  const evaluator = new Evaluator();
  evaluator.useGroups = false;

  const [addedBrush, removedBrush, unchangedBrush] = evaluator.evaluate(
    oldBrush,
    newBrush,
    [REVERSE_SUBTRACTION, SUBTRACTION, INTERSECTION],
    [new Brush(), new Brush(), new Brush()],
  );

  try {
    return {
      oldGeometry: geometryToPayload(oldGeometry),
      newGeometry: geometryToPayload(newGeometry),
      csgAdded: geometryToPayload(addedBrush.geometry),
      csgRemoved: geometryToPayload(removedBrush.geometry),
      csgUnchanged: geometryToPayload(unchangedBrush.geometry),
    };
  } finally {
    addedBrush.geometry.dispose();
    removedBrush.geometry.dispose();
    unchangedBrush.geometry.dispose();
  }
}

async function handleParseRequest(
  request: ParseStlRequest,
): Promise<ParseStlWorkerSuccess> {
  const mod = await getParserModule();
  const { positions, normals } = parseStl(mod, request.buffer);
  const workerGeometry = new BufferGeometry();
  workerGeometry.setAttribute("position", new BufferAttribute(positions, 3));

  // MeshBVH generation is eager in the installed library version, so construction
  // here performs the full spatial index build off the main thread.
  const serializedBVH = MeshBVH.serialize(new MeshBVH(workerGeometry));
  workerGeometry.dispose();

  return {
    id: request.id,
    type: "PARSE_STL_RESULT",
    positions,
    normals,
    serializedBVH,
  };
}

async function handleComputeDiffRequest(
  request: ComputeDiffRequest,
): Promise<ComputeDiffWorkerSuccess> {
  const mod = await getParserModule();
  const parsedOld = request.oldBuffer ? parseStl(mod, request.oldBuffer) : null;
  const parsedNew = request.newBuffer ? parseStl(mod, request.newBuffer) : null;
  const parsedOldGeometry = parsedOld
    ? buildGeometry(parsedOld.positions, parsedOld.normals)
    : null;
  const parsedNewGeometry = parsedNew
    ? buildGeometry(parsedNew.positions, parsedNew.normals)
    : null;

  try {
    return {
      id: request.id,
      type: "COMPUTE_DIFF_RESULT",
      ...computeDiffPayload(parsedOldGeometry, parsedNewGeometry),
    };
  } finally {
    parsedOldGeometry?.dispose();
    parsedNewGeometry?.dispose();
  }
}

self.onmessage = async (event: MessageEvent<StlWorkerRequest>) => {
  const request = event.data;

  try {
    if (request.type === "PARSE_STL") {
      const response = await handleParseRequest(request);

      (self as DedicatedWorkerGlobalScope).postMessage(
        response,
        getTransferablesForGeometryPayload(
          response.positions,
          response.normals,
          response.serializedBVH,
        ),
      );
      return;
    }

    const response = await handleComputeDiffRequest(request);

    (self as DedicatedWorkerGlobalScope).postMessage(
      response,
      [
        ...getTransferablesForFlatGeometry(response.oldGeometry),
        ...getTransferablesForFlatGeometry(response.newGeometry),
        ...getTransferablesForFlatGeometry(response.csgAdded),
        ...getTransferablesForFlatGeometry(response.csgRemoved),
        ...getTransferablesForFlatGeometry(response.csgUnchanged),
      ],
    );
  } catch (error) {
    const failure: StlWorkerFailure =
      error instanceof StlParserError
        ? {
            id: request.id,
            type: "ERROR",
            error: error.message,
            errorCode: error.code,
          }
        : {
            id: request.id,
            type: "ERROR",
            error: error instanceof Error ? error.message : String(error),
          };

    self.postMessage(failure);
  }
};
