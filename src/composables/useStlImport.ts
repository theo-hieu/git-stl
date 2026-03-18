import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { Box3, BufferAttribute, BufferGeometry, Vector3 } from "three";
import { MeshBVH, type SerializedBVH } from "three-mesh-bvh";
import { computed, markRaw, ref } from "vue";
import {
  activeMeshName,
  activeProjectName,
  assembly,
  cameraPosition,
  controlsTarget,
  createAssemblyItem,
  selectedItemId,
  type AssemblyItem,
  type AssemblyVector3,
} from "../store";

type Axis = "x" | "y" | "z";

interface StlWorkerRequest {
  id: number;
  buffer: ArrayBuffer;
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

type StlWorkerResponse = StlWorkerSuccess | StlWorkerFailure;

interface QueuedFile {
  batchId: number;
  filePath: string;
  order: number;
}

interface PendingBatch {
  expected: number;
  completed: number;
  frameOnComplete: boolean;
  results: Array<AssemblyItem | undefined>;
  resolve: (items: AssemblyItem[]) => void;
}

interface ProcessStlFilesOptions {
  frameOnComplete?: boolean;
}

class StlImportError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

const fileQueue = ref<QueuedFile[]>([]);
const activeWorkers = ref(0);
const totalFilesToLoad = ref(0);
const filesLoaded = ref(0);
const geometryCache = new Map<string, CachedGeometryEntry>();
const pendingBatches = new Map<number, PendingBatch>();
const idleWorkers: Worker[] = [];
const workerLimit =
  navigator.hardwareConcurrency && navigator.hardwareConcurrency > 1
    ? navigator.hardwareConcurrency - 1
    : 1;

let requestSequence = 0;
let batchSequence = 0;

const isImporting = computed(
  () => totalFilesToLoad.value > 0 && filesLoaded.value < totalFilesToLoad.value,
);

interface CachedGeometryEntry {
  geometry: BufferGeometry;
  refCount: number;
}

type IndexArray = Uint16Array | Uint32Array;

function createWorkerRequestId(): number {
  requestSequence += 1;
  return requestSequence;
}

function createBatchId(): number {
  batchSequence += 1;
  return batchSequence;
}

function getGeometryCacheKey(filePath: string): string {
  return filePath.toLowerCase();
}

function deriveProjectName(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
  return fileName.replace(/\.stl$/i, "") || "assembly-project";
}

function buildGeometry(
  positions: Float32Array,
  normals: Float32Array,
  serializedBVH: SerializedBVH,
): BufferGeometry {
  if (normals.length !== positions.length) {
    throw new Error("STL parser returned mismatched position and normal buffers.");
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(normals, 3));

  if (serializedBVH.index) {
    geometry.setIndex(new BufferAttribute(serializedBVH.index as IndexArray, 1));
  }

  geometry.boundsTree = MeshBVH.deserialize(serializedBVH, geometry, {
    setIndex: false,
  });
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return markRaw(geometry);
}

function resolveSelectedIndex(itemId: string): number {
  return assembly.value.findIndex((item) => item.id === itemId);
}

function acquireWorker(): Worker {
  return (
    idleWorkers.pop() ??
    new Worker(new URL("../workers/stlWorker.ts", import.meta.url), {
      type: "module",
    })
  );
}

function releaseWorker(worker: Worker): void {
  if (idleWorkers.length < workerLimit) {
    idleWorkers.push(worker);
    return;
  }

  worker.terminate();
}

function releaseAssemblyItemResources(item: AssemblyItem): void {
  item.material.dispose();

  const cacheKey = getGeometryCacheKey(item.sourcePath);
  const cachedEntry = geometryCache.get(cacheKey);

  if (cachedEntry && cachedEntry.geometry === item.geometry) {
    cachedEntry.refCount -= 1;

    if (cachedEntry.refCount <= 0) {
      if (cachedEntry.geometry.boundsTree) {
        cachedEntry.geometry.disposeBoundsTree();
      }
      cachedEntry.geometry.dispose();
      geometryCache.delete(cacheKey);
    }

    return;
  }

  if (item.geometry.boundsTree) {
    item.geometry.disposeBoundsTree();
  }
  item.geometry.dispose();
}

async function parseStlBuffer(buffer: ArrayBuffer): Promise<BufferGeometry> {
  return new Promise((resolve, reject) => {
    const worker = acquireWorker();
    const requestId = createWorkerRequestId();

    worker.onmessage = (event: MessageEvent<StlWorkerResponse>) => {
      const response = event.data;
      releaseWorker(worker);

      if ("error" in response) {
        reject(new StlImportError(response.error, response.errorCode));
        return;
      }

      resolve(
        buildGeometry(response.positions, response.normals, response.serializedBVH),
      );
    };

    worker.onerror = (event: ErrorEvent) => {
      worker.terminate();
      reject(new Error(event.message));
    };

    const request: StlWorkerRequest = { id: requestId, buffer };
    worker.postMessage(request, [buffer]);
  });
}

function frameAssembly(): void {
  if (assembly.value.length === 0) {
    return;
  }

  const masterBox = new Box3();
  const worldBox = new Box3();
  const offset = new Vector3();

  for (const item of assembly.value) {
    item.geometry.computeBoundingBox();

    if (!item.geometry.boundingBox) {
      continue;
    }

    worldBox.copy(item.geometry.boundingBox);
    offset.set(item.position[0], item.position[1], item.position[2]);
    worldBox.translate(offset);
    masterBox.union(worldBox);
  }

  if (masterBox.isEmpty()) {
    return;
  }

  const center = new Vector3();
  const size = new Vector3();
  masterBox.getCenter(center);
  masterBox.getSize(size);

  const maxDimension = Math.max(size.x, size.y, size.z) || 1;

  controlsTarget.value = [center.x, center.y, center.z];
  cameraPosition.value = [
    center.x + maxDimension * 1.5,
    center.y + maxDimension * 1.5,
    center.z + maxDimension * 1.5,
  ];
}

async function processFile(queuedFile: QueuedFile): Promise<void> {
  const { batchId, filePath, order } = queuedFile;
  const name = filePath.split(/[\\/]/).pop() ?? filePath;

  try {
    const cacheKey = getGeometryCacheKey(filePath);
    const cachedGeometry = geometryCache.get(cacheKey);
    let geometry: BufferGeometry;

    if (cachedGeometry) {
      cachedGeometry.refCount += 1;
      geometry = cachedGeometry.geometry;
    } else {
      const fileContents = await readFile(filePath);
      const buffer = fileContents.buffer.slice(
        fileContents.byteOffset,
        fileContents.byteOffset + fileContents.byteLength,
      );
      geometry = await parseStlBuffer(buffer);
      geometryCache.set(cacheKey, { geometry, refCount: 1 });
    }

    const item = createAssemblyItem({
      name,
      sourcePath: filePath,
      geometry,
    });

    assembly.value.push(item);
    activeMeshName.value = item.name;
    selectedItemId.value = item.id;

    const batch = pendingBatches.get(batchId);
    if (batch) {
      batch.results[order] = item;
    }
  } catch (error) {
    if (error instanceof StlImportError && error.code === "ascii_stl_unsupported") {
      alert(
        `"${name}" looks like an ASCII STL. Binary STL import is currently supported in the Wasm parser path.`,
      );
    } else {
      console.error(`Failed to import STL "${name}":`, error);
    }
  } finally {
    filesLoaded.value += 1;
    activeWorkers.value -= 1;

    const batch = pendingBatches.get(batchId);
    if (batch) {
      batch.completed += 1;

      if (batch.completed === batch.expected) {
        const completedItems = batch.results.filter(
          (item): item is AssemblyItem => item !== undefined,
        );

        pendingBatches.delete(batchId);

        if (batch.frameOnComplete && completedItems.length > 0) {
          frameAssembly();
        }

        batch.resolve(completedItems);
      }
    }

    void processNextInQueue();
  }
}

async function processNextInQueue(): Promise<void> {
  while (activeWorkers.value < workerLimit && fileQueue.value.length > 0) {
    const nextFile = fileQueue.value.shift();
    if (!nextFile) {
      return;
    }

    activeWorkers.value += 1;
    void processFile(nextFile);
  }
}

async function processStlFiles(
  filePaths: string[],
  options: ProcessStlFilesOptions = {},
): Promise<AssemblyItem[]> {
  if (filePaths.length === 0) {
    return [];
  }

  if (
    pendingBatches.size === 0 &&
    activeWorkers.value === 0 &&
    fileQueue.value.length === 0
  ) {
    totalFilesToLoad.value = 0;
    filesLoaded.value = 0;
  }

  const batchId = createBatchId();
  totalFilesToLoad.value += filePaths.length;

  const batchPromise = new Promise<AssemblyItem[]>((resolve) => {
    pendingBatches.set(batchId, {
      expected: filePaths.length,
      completed: 0,
      frameOnComplete: options.frameOnComplete ?? true,
      results: new Array<AssemblyItem | undefined>(filePaths.length),
      resolve,
    });
  });

  fileQueue.value.push(
    ...filePaths.map((filePath, order) => ({
      batchId,
      filePath,
      order,
    })),
  );

  await processNextInQueue();
  return batchPromise;
}

async function openFiles(): Promise<void> {
  const selected = await open({
    multiple: true,
    filters: [{ name: "STL Files", extensions: ["stl"] }],
  });

  if (!selected) {
    return;
  }

  const paths = Array.isArray(selected) ? selected : [selected];
  if (paths.length === 0) {
    return;
  }

  if (!activeProjectName.value) {
    activeProjectName.value = deriveProjectName(paths[0]);
  }

  await processStlFiles(paths);
}

function selectItem(itemId: string | null): void {
  selectedItemId.value = itemId;
}

function updateItemPosition(itemId: string, axis: Axis, value: number): void {
  const item = assembly.value.find((entry) => entry.id === itemId);
  if (!item) {
    return;
  }

  const axisIndex = axis === "x" ? 0 : axis === "y" ? 1 : 2;
  item.position[axisIndex] = value;
}

function updateItemTransform(
  itemId: string,
  position: AssemblyVector3,
  rotation: AssemblyVector3,
): void {
  const item = assembly.value.find((entry) => entry.id === itemId);
  if (!item) {
    return;
  }

  if (item.position[0] !== position[0]) {
    item.position[0] = position[0];
  }
  if (item.position[1] !== position[1]) {
    item.position[1] = position[1];
  }
  if (item.position[2] !== position[2]) {
    item.position[2] = position[2];
  }

  if (item.rotation[0] !== rotation[0]) {
    item.rotation[0] = rotation[0];
  }
  if (item.rotation[1] !== rotation[1]) {
    item.rotation[1] = rotation[1];
  }
  if (item.rotation[2] !== rotation[2]) {
    item.rotation[2] = rotation[2];
  }
}

function toggleItemVisibility(itemId: string, visible: boolean): void {
  const item = assembly.value.find((entry) => entry.id === itemId);
  if (!item) {
    return;
  }

  item.visible = visible;
}

function removePart(itemId: string): void {
  const index = resolveSelectedIndex(itemId);
  if (index === -1) {
    return;
  }

  const part = assembly.value[index];
  releaseAssemblyItemResources(part);
  assembly.value.splice(index, 1);

  if (selectedItemId.value === itemId) {
    const fallbackItem = assembly.value[index] ?? assembly.value[index - 1] ?? null;
    selectedItemId.value = fallbackItem?.id ?? null;
  }

  if (activeMeshName.value === part.name) {
    activeMeshName.value = assembly.value[assembly.value.length - 1]?.name ?? null;
  }

  if (assembly.value.length === 0) {
    activeProjectName.value = null;
  }
}

function clearAssembly(): void {
  const existingItems = [...assembly.value];

  for (const item of existingItems) {
    releaseAssemblyItemResources(item);
  }

  assembly.value = [];
  selectedItemId.value = null;
  activeMeshName.value = null;

  if (
    pendingBatches.size === 0 &&
    activeWorkers.value === 0 &&
    fileQueue.value.length === 0
  ) {
    totalFilesToLoad.value = 0;
    filesLoaded.value = 0;
  }
}

export function useStlImport() {
  return {
    clearAssembly,
    filesLoaded,
    frameAssembly,
    isImporting,
    openFiles,
    processStlFiles,
    removePart,
    releaseAssemblyItemResources,
    selectItem,
    toggleItemVisibility,
    totalFilesToLoad,
    updateItemTransform,
    updateItemPosition,
  };
}
