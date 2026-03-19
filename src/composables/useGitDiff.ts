import { invoke } from "@tauri-apps/api/core";
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  EdgesGeometry,
  Vector3,
  type Material,
} from "three";
import { computed, markRaw, ref, shallowRef, triggerRef, watch } from "vue";
import { useStlImport, releaseGeometryResources, parseStlArrayBuffer } from "./useStlImport";
import {
  MANIFEST_FILE_NAME,
  PARTS_DIRECTORY_NAME,
  getProjectDirectory,
  parseManifest,
  type AssemblyManifest,
  type AssemblyManifestItem,
} from "./useVersioning";
import {
  activeProjectName,
  assembly,
  cameraPosition,
  controlsTarget,
  type AssemblyVector3,
} from "../store";
import {
  diffGreenEdgeMaterial,
  diffGreenMaterial,
  diffRedEdgeMaterial,
  diffRedMaterial,
} from "../materials/diffMaterials";

export interface GitDiffFile {
  path: string;
  old_path: string | null;
  new_path: string | null;
  status: "added" | "modified" | "deleted";
  is_stl: boolean;
  geometry_changed: boolean;
}

export interface ManifestDiffEntry {
  path: string;
  change_type: "added" | "removed" | "modified";
  old_value: unknown | null;
  new_value: unknown | null;
  message: string;
}

export interface CommitDiffResult {
  base_sha: string;
  head_sha: string;
  files: GitDiffFile[];
  geometry_changed: boolean;
  manifest_diff: ManifestDiffEntry[];
}

export type DiffItemStatus = "modified" | "added" | "removed" | "unchanged";

export interface DiffItem {
  id: string;
  filename: string;
  filePath: string;
  name: string;
  status: DiffItemStatus;
  oldGeometry: BufferGeometry | null;
  newGeometry: BufferGeometry | null;
  csgAdded: BufferGeometry | null;
  csgRemoved: BufferGeometry | null;
  csgUnchanged: BufferGeometry | null;
  oldEdgesGeometry: BufferGeometry | null;
  newEdgesGeometry: BufferGeometry | null;
  visible: boolean;
  oldMaterial: Material | null;
  newMaterial: Material | null;
  oldEdgeMaterial: Material | null;
  newEdgeMaterial: Material | null;
  oldPosition: AssemblyVector3;
  newPosition: AssemblyVector3;
  oldRotation: AssemblyVector3;
  newRotation: AssemblyVector3;
  oldScale: AssemblyVector3;
  newScale: AssemblyVector3;
  oldPath: string | null;
  newPath: string | null;
  geometryChanged: boolean;
  oldGeometryCacheKey: string | null;
  newGeometryCacheKey: string | null;
  isHydrated: boolean;
  isHydrating: boolean;
  isCsgHydrated: boolean;
  isCsgHydrating: boolean;
  hydrationPromise?: Promise<void>;
  csgHydrationPromise?: Promise<void>;
}

export type DiffViewMode = "overlay" | "csg";

interface DiffOverlayCandidate {
  id: string;
  filename: string;
  name: string;
  status: DiffItemStatus;
  oldPath: string | null;
  newPath: string | null;
  oldItem: AssemblyManifestItem | null;
  newItem: AssemblyManifestItem | null;
  geometryChanged: boolean;
}

const availableHardwareThreads = navigator.hardwareConcurrency ?? 2;
const diffHydrationWorkerLimit = Math.max(
  1,
  Math.min(4, availableHardwareThreads > 1 ? availableHardwareThreads - 1 : 1),
);
const diffCsgWorkerLimit = 1;
const MIN_DIFF_CHUNK_SIZE = 2;
const MAX_DIFF_CHUNK_SIZE = 5;
const DIFF_EDGE_THRESHOLD_ANGLE = 15;

const textDecoder = new TextDecoder();
const isDiffMode = ref(false);
const isLoadingDiff = ref(false);
const diffError = ref<string | null>(null);
const diffResult = ref<CommitDiffResult | null>(null);
const diffItems = shallowRef<DiffItem[]>([]);
const diffViewMode = ref<DiffViewMode>("overlay");
const diffOpacity = ref(0.5);
const selectedBaseSha = ref<string | null>(null);
const selectedHeadSha = ref<string | null>(null);

let activeLoadSequence = 0;
let activeDiffHydrationCount = 0;
let activeDiffCsgHydrationCount = 0;
let activeDiffContext: DiffHydrationContext | null = null;
let activeDiffInsertionFrame: number | null = null;
let pendingStaggeredDiffPayload: DiffItem[] | null = null;
let diffWorkerRequestSequence = 0;

const diffGeometryCache = new Map<string, CachedDiffGeometryEntry>();
const pendingDiffGeometryLoads = new Map<string, Promise<CachedDiffGeometryEntry>>();
const pendingDiffHydrationTasks: DiffHydrationTask[] = [];
const pendingDiffCsgHydrationTasks: DiffCsgHydrationTask[] = [];
const idleDiffWorkers: Worker[] = [];

interface CachedDiffGeometryEntry {
  geometry: BufferGeometry;
  edgesGeometry: BufferGeometry;
  refCount: number;
}

interface DiffHydrationContext {
  requestId: number;
  repoPath: string;
  baseSha: string;
  headSha: string;
}

interface DiffHydrationTask extends DiffHydrationContext {
  item: DiffItem;
  resolve: () => void;
}

interface DiffFlatGeometryPayload {
  positions: Float32Array;
  normals: Float32Array;
}

interface ComputeDiffWorkerRequest {
  id: number;
  type: "COMPUTE_DIFF";
  oldBuffer: ArrayBuffer | null;
  newBuffer: ArrayBuffer | null;
}

interface ComputeDiffWorkerSuccess {
  id: number;
  type: "COMPUTE_DIFF_RESULT";
  oldGeometry: DiffFlatGeometryPayload | null;
  newGeometry: DiffFlatGeometryPayload | null;
  csgAdded: DiffFlatGeometryPayload | null;
  csgRemoved: DiffFlatGeometryPayload | null;
  csgUnchanged: DiffFlatGeometryPayload | null;
}

interface StlWorkerFailure {
  id: number;
  type: "ERROR";
  error: string;
  errorCode?: string;
}

type DiffWorkerResponse = ComputeDiffWorkerSuccess | StlWorkerFailure;

interface DiffCsgHydrationTask extends DiffHydrationContext {
  item: DiffItem;
  resolve: () => void;
}

function clampDiffOpacity(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }

  return Math.min(1, Math.max(0, value));
}

function cloneVector3(
  value: AssemblyVector3 | undefined,
  fallback: AssemblyVector3 = [0, 0, 0],
): AssemblyVector3 {
  return value ? [...value] as AssemblyVector3 : [...fallback] as AssemblyVector3;
}

function disposeOverlayGeometry(geometry: BufferGeometry | null): void {
  if (!geometry) {
    return;
  }

  releaseGeometryResources(geometry);
}

function createDiffEdgesGeometry(geometry: BufferGeometry): BufferGeometry {
  return markRaw(
    new EdgesGeometry(geometry, DIFF_EDGE_THRESHOLD_ANGLE),
  ) as BufferGeometry;
}

function createDiffWorkerRequestId(): number {
  diffWorkerRequestSequence += 1;
  return diffWorkerRequestSequence;
}

function acquireDiffWorker(): Worker {
  return (
    idleDiffWorkers.pop() ??
    new Worker(new URL("../workers/stlWorker.ts", import.meta.url), {
      type: "module",
    })
  );
}

function releaseDiffWorker(worker: Worker): void {
  if (idleDiffWorkers.length < diffCsgWorkerLimit) {
    idleDiffWorkers.push(worker);
    return;
  }

  worker.terminate();
}

function cloneBufferForWorker(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function buildWorkerGeometry(
  payload: DiffFlatGeometryPayload | null,
): BufferGeometry | null {
  if (!payload || payload.positions.length === 0) {
    return null;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(payload.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(payload.normals, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return markRaw(geometry);
}

async function computeCsgDiffPayload(
  oldBuffer: ArrayBuffer | null,
  newBuffer: ArrayBuffer | null,
): Promise<ComputeDiffWorkerSuccess> {
  return new Promise((resolve, reject) => {
    const worker = acquireDiffWorker();
    const requestId = createDiffWorkerRequestId();

    worker.onmessage = (event: MessageEvent<DiffWorkerResponse>) => {
      const response = event.data;
      releaseDiffWorker(worker);

      if ("error" in response) {
        reject(new Error(response.error));
        return;
      }

      resolve(response);
    };

    worker.onerror = (event: ErrorEvent) => {
      worker.terminate();
      reject(new Error(event.message));
    };

    const request: ComputeDiffWorkerRequest = {
      id: requestId,
      type: "COMPUTE_DIFF",
      oldBuffer,
      newBuffer,
    };
    const transferables = [oldBuffer, newBuffer].filter(
      (buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer,
    );

    worker.postMessage(request, transferables);
  });
}

function buildDiffGeometryCacheKey(sha: string, filePath: string): string {
  return `${sha}:${normalizeRepoPath(filePath) ?? filePath}`;
}

function retainDiffGeometryReference(cacheKey: string): void {
  const cachedEntry = diffGeometryCache.get(cacheKey);
  if (!cachedEntry) {
    return;
  }

  cachedEntry.refCount += 1;
}

function releaseDiffGeometryReference(
  cacheKey: string | null,
  geometry: BufferGeometry | null,
  edgesGeometry: BufferGeometry | null,
): void {
  if (!geometry && !edgesGeometry) {
    return;
  }

  if (!cacheKey) {
    disposeOverlayGeometry(geometry);
    disposeOverlayGeometry(edgesGeometry);
    return;
  }

  const cachedEntry = diffGeometryCache.get(cacheKey);
  if (!cachedEntry || cachedEntry.geometry !== geometry) {
    disposeOverlayGeometry(geometry);
    disposeOverlayGeometry(edgesGeometry);
    return;
  }

  cachedEntry.refCount -= 1;

  if (cachedEntry.refCount <= 0) {
    disposeOverlayGeometry(cachedEntry.geometry);
    disposeOverlayGeometry(cachedEntry.edgesGeometry);
    diffGeometryCache.delete(cacheKey);
  }
}

function disposeDiffItemResources(items: DiffItem[]): void {
  for (const item of items) {
    releaseDiffGeometryReference(
      item.oldGeometryCacheKey,
      item.oldGeometry,
      item.oldEdgesGeometry,
    );
    releaseDiffGeometryReference(
      item.newGeometryCacheKey,
      item.newGeometry,
      item.newEdgesGeometry,
    );
    disposeOverlayGeometry(item.csgAdded);
    disposeOverlayGeometry(item.csgRemoved);
    disposeOverlayGeometry(item.csgUnchanged);
    item.oldGeometry = null;
    item.newGeometry = null;
    item.csgAdded = null;
    item.csgRemoved = null;
    item.csgUnchanged = null;
    item.oldEdgesGeometry = null;
    item.newEdgesGeometry = null;
    item.oldMaterial = null;
    item.newMaterial = null;
    item.oldEdgeMaterial = null;
    item.newEdgeMaterial = null;
    item.oldGeometryCacheKey = null;
    item.newGeometryCacheKey = null;
    item.isHydrated = false;
    item.isHydrating = false;
    item.isCsgHydrated = false;
    item.isCsgHydrating = false;
    item.hydrationPromise = undefined;
    item.csgHydrationPromise = undefined;
  }
}

function setDiffMaterialState(
  material: Material | null,
  opacity: number,
): void {
  if (!material) {
    return;
  }

  const isFullyOpaque = opacity === 1;
  const shouldBeTransparent = !isFullyOpaque;
  const transparencyModeChanged =
    material.transparent !== shouldBeTransparent ||
    material.depthWrite !== isFullyOpaque;

  material.opacity = opacity;
  material.transparent = shouldBeTransparent;
  material.depthWrite = isFullyOpaque;
  material.visible = opacity > 0.001;

  if (transparencyModeChanged) {
    material.needsUpdate = true;
  }
}

function applyDiffVisualization(items: DiffItem[]): void {
  const clampedOpacity = clampDiffOpacity(diffOpacity.value);
  const baseOpacity = 1 - clampedOpacity;
  const headOpacity = clampedOpacity;

  for (const item of items) {
    setDiffMaterialState(item.oldMaterial, baseOpacity);
    setDiffMaterialState(item.newMaterial, headOpacity);
    setDiffMaterialState(item.oldEdgeMaterial, baseOpacity * 0.8);
    setDiffMaterialState(item.newEdgeMaterial, headOpacity * 0.8);
  }
}

function resetDiffResources(): void {
  cancelStaggeredDiffInsertion();
  disposePendingStaggeredDiffPayload();

  if (diffItems.value.length > 0) {
    disposeDiffItemResources(diffItems.value);
    diffItems.value = [];
  }
}

function clearPendingDiffHydrationTasks(): void {
  while (pendingDiffHydrationTasks.length > 0) {
    const task = pendingDiffHydrationTasks.shift();
    if (!task) {
      continue;
    }

    task.item.hydrationPromise = undefined;
    task.item.isHydrating = false;
    task.resolve();
  }
}

function clearPendingDiffCsgHydrationTasks(): void {
  while (pendingDiffCsgHydrationTasks.length > 0) {
    const task = pendingDiffCsgHydrationTasks.shift();
    if (!task) {
      continue;
    }

    task.item.csgHydrationPromise = undefined;
    task.item.isCsgHydrating = false;
    task.resolve();
  }
}

function cancelStaggeredDiffInsertion(): void {
  if (activeDiffInsertionFrame === null) {
    return;
  }

  cancelAnimationFrame(activeDiffInsertionFrame);
  activeDiffInsertionFrame = null;
}

function disposePendingStaggeredDiffPayload(): void {
  if (!pendingStaggeredDiffPayload || pendingStaggeredDiffPayload.length === 0) {
    pendingStaggeredDiffPayload = null;
    return;
  }

  disposeDiffItemResources(pendingStaggeredDiffPayload);
  pendingStaggeredDiffPayload = null;
}

function frameDiffItems(items: DiffItem[]): void {
  if (items.length === 0) {
    return;
  }

  const masterBox = new Box3();
  const worldBox = new Box3();
  const offset = new Vector3();

  for (const item of items) {
    const snapshots = [
      {
        geometry: item.oldGeometry,
        position: item.oldPosition,
      },
      {
        geometry: item.newGeometry,
        position: item.newPosition,
      },
    ];

    for (const snapshot of snapshots) {
      if (!snapshot.geometry) {
        continue;
      }

      const boundingBox =
        snapshot.geometry.boundingBox ??
        (snapshot.geometry.computeBoundingBox(), snapshot.geometry.boundingBox);

      if (!boundingBox) {
        continue;
      }

      worldBox.copy(boundingBox);
      offset.set(snapshot.position[0], snapshot.position[1], snapshot.position[2]);
      worldBox.translate(offset);
      masterBox.union(worldBox);
    }
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

function getDiffGeometryVertexCount(geometry: BufferGeometry | null): number {
  if (!geometry) {
    return 0;
  }

  return geometry.getAttribute("position")?.count ?? 0;
}

function determineDiffChunkSize(items: DiffItem[]): number {
  if (items.length === 0) {
    return MAX_DIFF_CHUNK_SIZE;
  }

  const totalVertexCount = items.reduce(
    (sum, item) =>
      sum +
      getDiffGeometryVertexCount(item.oldGeometry) +
      getDiffGeometryVertexCount(item.newGeometry),
    0,
  );
  const averageVertexCount = totalVertexCount / items.length;

  if (averageVertexCount >= 400_000) {
    return MIN_DIFF_CHUNK_SIZE;
  }

  if (averageVertexCount >= 150_000) {
    return 3;
  }

  return MAX_DIFF_CHUNK_SIZE;
}

function insertDiffItemsInChunks(
  parsedDiffPayload: DiffItem[],
  requestId: number,
): Promise<void> {
  cancelStaggeredDiffInsertion();
  disposePendingStaggeredDiffPayload();

  diffItems.value = [];
  pendingStaggeredDiffPayload = parsedDiffPayload;

  if (pendingStaggeredDiffPayload.length === 0) {
    pendingStaggeredDiffPayload = null;
    isLoadingDiff.value = false;
    return Promise.resolve();
  }

  const chunkSize = determineDiffChunkSize(parsedDiffPayload);

  return new Promise((resolve) => {
    const pushNextChunk = () => {
      if (requestId !== activeLoadSequence || !isDiffMode.value) {
        cancelStaggeredDiffInsertion();
        resolve();
        return;
      }

      const remainingPayload = pendingStaggeredDiffPayload;
      if (!remainingPayload || remainingPayload.length === 0) {
        pendingStaggeredDiffPayload = null;
        activeDiffInsertionFrame = null;
        isLoadingDiff.value = false;
        resolve();
        return;
      }

      const nextChunk = remainingPayload.splice(0, chunkSize);
      if (nextChunk.length > 0) {
        diffItems.value.push(...nextChunk);
        triggerRef(diffItems);
      }

      if (remainingPayload.length > 0) {
        activeDiffInsertionFrame = requestAnimationFrame(pushNextChunk);
        return;
      }

      pendingStaggeredDiffPayload = null;
      activeDiffInsertionFrame = null;
      isLoadingDiff.value = false;
      resolve();
    };

    activeDiffInsertionFrame = requestAnimationFrame(pushNextChunk);
  });
}

function buildPartRepoPath(fileName: string): string {
  return `${PARTS_DIRECTORY_NAME}/${fileName}`;
}

function buildManifestCandidateId(itemId: string): string {
  return `item:${itemId}`;
}

function normalizeRepoPath(path: string | null): string | null {
  return path ? path.replace(/\\/g, "/").toLowerCase() : null;
}

function resolveManifestItem(
  manifest: AssemblyManifest | null,
  repoRelativePath: string | null,
): AssemblyManifestItem | null {
  if (!manifest || !repoRelativePath) {
    return null;
  }

  const fileName = repoRelativePath.replace(/\\/g, "/").split("/").pop();
  if (!fileName) {
    return null;
  }

  return manifest.items.find((item) => item.fileName === fileName) ?? null;
}

async function readFileAtSha(
  repoPath: string,
  sha: string,
  filePath: string,
): Promise<Uint8Array> {
  const bytes = await invoke<number[]>("get_file_at_sha", {
    repoPath,
    sha,
    filePath,
  });

  return Uint8Array.from(bytes);
}

async function readOptionalManifestAtSha(
  repoPath: string,
  sha: string,
): Promise<AssemblyManifest | null> {
  try {
    const bytes = await readFileAtSha(repoPath, sha, MANIFEST_FILE_NAME);
    return parseManifest(textDecoder.decode(bytes));
  } catch (error) {
    console.warn(`Failed to load manifest.json for ${sha}:`, error);
    return null;
  }
}

async function parseOverlayGeometry(
  repoPath: string,
  sha: string,
  filePath: string | null,
): Promise<BufferGeometry | null> {
  if (!filePath) {
    return null;
  }

  const bytes = await readFileAtSha(repoPath, sha, filePath);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return parseStlArrayBuffer(buffer);
}

async function loadDiffGeometry(
  repoPath: string,
  sha: string,
  filePath: string,
): Promise<{
  cacheKey: string;
  geometry: BufferGeometry;
  edgesGeometry: BufferGeometry;
}> {
  const cacheKey = buildDiffGeometryCacheKey(sha, filePath);
  const cachedEntry = diffGeometryCache.get(cacheKey);

  if (cachedEntry) {
    cachedEntry.refCount += 1;
    return {
      cacheKey,
      geometry: cachedEntry.geometry,
      edgesGeometry: cachedEntry.edgesGeometry,
    };
  }

  let pendingLoad = pendingDiffGeometryLoads.get(cacheKey);
  if (!pendingLoad) {
    pendingLoad = parseOverlayGeometry(repoPath, sha, filePath).then((geometry) => {
      if (!geometry) {
        throw new Error(`Unable to load diff geometry for "${filePath}".`);
      }

      const cachedGeometryEntry = {
        geometry,
        edgesGeometry: createDiffEdgesGeometry(geometry),
        refCount: 0,
      };

      diffGeometryCache.set(cacheKey, cachedGeometryEntry);

      return cachedGeometryEntry;
    });

    pendingDiffGeometryLoads.set(cacheKey, pendingLoad);
  }

  try {
    const cachedGeometryEntry = await pendingLoad;
    const resolvedEntry = diffGeometryCache.get(cacheKey);

    if (!resolvedEntry) {
      diffGeometryCache.set(cacheKey, {
        geometry: cachedGeometryEntry.geometry,
        edgesGeometry: cachedGeometryEntry.edgesGeometry,
        refCount: 1,
      });
    } else {
      resolvedEntry.refCount += 1;
    }

    return {
      cacheKey,
      geometry: cachedGeometryEntry.geometry,
      edgesGeometry: cachedGeometryEntry.edgesGeometry,
    };
  } finally {
    pendingDiffGeometryLoads.delete(cacheKey);
  }
}

function buildOverlayName(
  fallbackPath: string,
  oldItem: AssemblyManifestItem | null,
  newItem: AssemblyManifestItem | null,
): string {
  return (
    newItem?.name ??
    oldItem?.name ??
    fallbackPath.replace(/\\/g, "/").split("/").pop() ??
    fallbackPath
  );
}

function buildDiffFileName(
  fallbackPath: string,
  oldItem: AssemblyManifestItem | null,
  newItem: AssemblyManifestItem | null,
): string {
  return (
    newItem?.fileName ??
    oldItem?.fileName ??
    fallbackPath.replace(/\\/g, "/").split("/").pop() ??
    fallbackPath
  );
}

function mapGitDiffStatus(status: GitDiffFile["status"]): Exclude<DiffItemStatus, "unchanged"> {
  if (status === "deleted") {
    return "removed";
  }

  return status;
}

function mergeDiffStatus(
  currentStatus: DiffItemStatus,
  nextStatus: DiffItemStatus,
): DiffItemStatus {
  if (currentStatus === nextStatus) {
    return currentStatus;
  }

  if (currentStatus === "added" || nextStatus === "added") {
    return "added";
  }

  if (currentStatus === "removed" || nextStatus === "removed") {
    return "removed";
  }

  if (currentStatus === "modified" || nextStatus === "modified") {
    return "modified";
  }

  return "unchanged";
}

function vectorsEqual(left: AssemblyVector3, right: AssemblyVector3): boolean {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}

function manifestItemsDiffer(
  oldItem: AssemblyManifestItem | null,
  newItem: AssemblyManifestItem | null,
): boolean {
  if (!oldItem || !newItem) {
    return oldItem !== newItem;
  }

  return (
    oldItem.name !== newItem.name ||
    oldItem.fileName !== newItem.fileName ||
    oldItem.visible !== newItem.visible ||
    !vectorsEqual(oldItem.scale, newItem.scale) ||
    !vectorsEqual(oldItem.position, newItem.position) ||
    !vectorsEqual(oldItem.rotation, newItem.rotation)
  );
}

function collectChangedStlPaths(diff: CommitDiffResult): Set<string> {
  const changedPaths = new Set<string>();

  for (const file of diff.files) {
    if (!file.is_stl) {
      continue;
    }

    for (const path of [file.path, file.old_path, file.new_path]) {
      const normalizedPath = normalizeRepoPath(path);
      if (normalizedPath) {
        changedPaths.add(normalizedPath);
      }
    }
  }

  return changedPaths;
}

function hasGeometryChangeForItem(
  oldItem: AssemblyManifestItem | null,
  newItem: AssemblyManifestItem | null,
  changedStlPaths: Set<string>,
): boolean {
  const paths = [
    oldItem ? buildPartRepoPath(oldItem.fileName) : null,
    newItem ? buildPartRepoPath(newItem.fileName) : null,
  ];

  return paths.some((path) => {
    const normalizedPath = normalizeRepoPath(path);
    return normalizedPath ? changedStlPaths.has(normalizedPath) : false;
  });
}

function collectManifestOverlayCandidates(
  baseManifest: AssemblyManifest | null,
  headManifest: AssemblyManifest | null,
  changedStlPaths: Set<string>,
): DiffOverlayCandidate[] {
  const baseItems = new Map(
    (baseManifest?.items ?? []).map((item) => [item.id, item] as const),
  );
  const headItems = new Map(
    (headManifest?.items ?? []).map((item) => [item.id, item] as const),
  );
  const itemIds = new Set([...baseItems.keys(), ...headItems.keys()]);
  const candidates: DiffOverlayCandidate[] = [];

  for (const itemId of itemIds) {
    const oldItem = baseItems.get(itemId) ?? null;
    const newItem = headItems.get(itemId) ?? null;
    const fallbackPath =
      newItem?.fileName ?? oldItem?.fileName ?? `manifest-item-${itemId}.stl`;
    const manifestChanged = manifestItemsDiffer(oldItem, newItem);
    const geometryChanged = hasGeometryChangeForItem(oldItem, newItem, changedStlPaths);
    const status: DiffItemStatus = !oldItem
      ? "added"
      : !newItem
        ? "removed"
        : manifestChanged || geometryChanged
          ? "modified"
          : "unchanged";

    candidates.push({
      id: buildManifestCandidateId(itemId),
      filename: buildDiffFileName(fallbackPath, oldItem, newItem),
      name: buildOverlayName(fallbackPath, oldItem, newItem),
      status,
      oldPath: oldItem ? buildPartRepoPath(oldItem.fileName) : null,
      newPath: newItem ? buildPartRepoPath(newItem.fileName) : null,
      oldItem,
      newItem,
      geometryChanged,
    });
  }

  return candidates;
}

function collectOverlayCandidates(
  diff: CommitDiffResult,
  baseManifest: AssemblyManifest | null,
  headManifest: AssemblyManifest | null,
): DiffOverlayCandidate[] {
  const changedStlPaths = collectChangedStlPaths(diff);
  const candidates = new Map<string, DiffOverlayCandidate>();

  for (const candidate of collectManifestOverlayCandidates(
    baseManifest,
    headManifest,
    changedStlPaths,
  )) {
    candidates.set(candidate.id, candidate);
  }

  for (const file of diff.files.filter((entry) => entry.is_stl)) {
    const oldItem = resolveManifestItem(baseManifest, file.old_path ?? file.path);
    const newItem = resolveManifestItem(headManifest, file.new_path ?? file.path);
    const candidateId =
      oldItem?.id || newItem?.id
        ? buildManifestCandidateId(oldItem?.id ?? newItem?.id ?? "")
        : `file:${file.old_path ?? file.new_path ?? file.path}`;
    const existingCandidate = candidates.get(candidateId);

    if (existingCandidate) {
      existingCandidate.status = mergeDiffStatus(
        existingCandidate.status,
        mapGitDiffStatus(file.status),
      );
      existingCandidate.geometryChanged =
        existingCandidate.geometryChanged || file.geometry_changed;
      existingCandidate.oldPath ??= file.old_path ?? file.path;
      existingCandidate.newPath ??= file.new_path ?? file.path;
      continue;
    }

    candidates.set(candidateId, {
      id: candidateId,
      filename: buildDiffFileName(file.path, oldItem, newItem),
      name: buildOverlayName(file.path, oldItem, newItem),
      status: mapGitDiffStatus(file.status),
      oldPath: file.old_path ?? file.path,
      newPath: file.new_path ?? file.path,
      oldItem,
      newItem,
      geometryChanged: file.geometry_changed,
    });
  }

  return [...candidates.values()];
}

function createDiffItem(
  baseSha: string,
  headSha: string,
  candidate: DiffOverlayCandidate,
): DiffItem {
  return {
    id: `${baseSha}:${headSha}:${candidate.id}`,
    filename: candidate.filename,
    filePath: candidate.newPath ?? candidate.oldPath ?? candidate.id,
    name: candidate.name,
    status: candidate.status,
    oldGeometry: null,
    newGeometry: null,
    csgAdded: null,
    csgRemoved: null,
    csgUnchanged: null,
    oldEdgesGeometry: null,
    newEdgesGeometry: null,
    visible: candidate.status !== "unchanged",
    oldMaterial: null,
    newMaterial: null,
    oldEdgeMaterial: null,
    newEdgeMaterial: null,
    oldPosition: cloneVector3(candidate.oldItem?.position),
    newPosition: cloneVector3(candidate.newItem?.position),
    oldRotation: cloneVector3(candidate.oldItem?.rotation),
    newRotation: cloneVector3(candidate.newItem?.rotation),
    oldScale: cloneVector3(candidate.oldItem?.scale, [1, 1, 1]),
    newScale: cloneVector3(candidate.newItem?.scale, [1, 1, 1]),
    oldPath: candidate.oldPath,
    newPath: candidate.newPath,
    geometryChanged: candidate.geometryChanged,
    oldGeometryCacheKey: null,
    newGeometryCacheKey: null,
    isHydrated: false,
    isHydrating: false,
    isCsgHydrated: false,
    isCsgHydrating: false,
  };
}

function canShareDiffGeometry(item: DiffItem): boolean {
  return (
    !item.geometryChanged &&
    item.status !== "added" &&
    item.status !== "removed" &&
    Boolean(item.oldPath) &&
    Boolean(item.newPath)
  );
}

function canHydrateCsgForItem(item: DiffItem): boolean {
  return (
    item.geometryChanged &&
    item.status === "modified" &&
    Boolean(item.oldPath) &&
    Boolean(item.newPath)
  );
}

async function hydrateDiffItemGeometry(
  item: DiffItem,
  context: DiffHydrationContext,
): Promise<void> {
  if (item.isHydrated) {
    return;
  }

  const shouldLoadOld = item.status !== "added" && Boolean(item.oldPath);
  const shouldLoadNew = item.status !== "removed" && Boolean(item.newPath);

  if (!shouldLoadOld && !shouldLoadNew) {
    item.isHydrated = true;
    return;
  }

  let oldGeometry: BufferGeometry | null = null;
  let newGeometry: BufferGeometry | null = null;
  let oldEdgesGeometry: BufferGeometry | null = null;
  let newEdgesGeometry: BufferGeometry | null = null;
  let oldGeometryCacheKey: string | null = null;
  let newGeometryCacheKey: string | null = null;

  try {
    if (canShareDiffGeometry(item)) {
      const sharedSourcePath = item.newPath ?? item.oldPath;
      const sharedSourceSha = item.newPath ? context.headSha : context.baseSha;

      if (!sharedSourcePath) {
        item.isHydrated = true;
        return;
      }

      const sharedGeometry = await loadDiffGeometry(
        context.repoPath,
        sharedSourceSha,
        sharedSourcePath,
      );

      if (shouldLoadOld) {
        oldGeometry = sharedGeometry.geometry;
        oldEdgesGeometry = sharedGeometry.edgesGeometry;
        oldGeometryCacheKey = sharedGeometry.cacheKey;
      }

      if (shouldLoadNew) {
        if (shouldLoadOld) {
          retainDiffGeometryReference(sharedGeometry.cacheKey);
        }

        newGeometry = sharedGeometry.geometry;
        newEdgesGeometry = sharedGeometry.edgesGeometry;
        newGeometryCacheKey = sharedGeometry.cacheKey;
      }
    } else {
      if (shouldLoadOld && item.oldPath) {
        const loadedOldGeometry = await loadDiffGeometry(
          context.repoPath,
          context.baseSha,
          item.oldPath,
        );

        oldGeometry = loadedOldGeometry.geometry;
        oldEdgesGeometry = loadedOldGeometry.edgesGeometry;
        oldGeometryCacheKey = loadedOldGeometry.cacheKey;
      }

      if (shouldLoadNew && item.newPath) {
        const loadedNewGeometry = await loadDiffGeometry(
          context.repoPath,
          context.headSha,
          item.newPath,
        );

        newGeometry = loadedNewGeometry.geometry;
        newEdgesGeometry = loadedNewGeometry.edgesGeometry;
        newGeometryCacheKey = loadedNewGeometry.cacheKey;
      }
    }

    if (context.requestId !== activeLoadSequence || !isDiffMode.value) {
      releaseDiffGeometryReference(
        oldGeometryCacheKey,
        oldGeometry,
        oldEdgesGeometry,
      );
      releaseDiffGeometryReference(
        newGeometryCacheKey,
        newGeometry,
        newEdgesGeometry,
      );
      return;
    }

    item.oldGeometry = oldGeometry ? markRaw(oldGeometry) : null;
    item.newGeometry = newGeometry ? markRaw(newGeometry) : null;
    item.oldEdgesGeometry = oldEdgesGeometry ? markRaw(oldEdgesGeometry) : null;
    item.newEdgesGeometry = newEdgesGeometry ? markRaw(newEdgesGeometry) : null;
    item.oldGeometryCacheKey = oldGeometryCacheKey;
    item.newGeometryCacheKey = newGeometryCacheKey;
    item.oldMaterial = oldGeometry ? diffRedMaterial : null;
    item.newMaterial = newGeometry ? diffGreenMaterial : null;
    item.oldEdgeMaterial = oldEdgesGeometry ? diffRedEdgeMaterial : null;
    item.newEdgeMaterial = newEdgesGeometry ? diffGreenEdgeMaterial : null;
    item.isHydrated = true;
    applyDiffVisualization([item]);
  } catch (error) {
    releaseDiffGeometryReference(
      oldGeometryCacheKey,
      oldGeometry,
      oldEdgesGeometry,
    );
    releaseDiffGeometryReference(
      newGeometryCacheKey,
      newGeometry,
      newEdgesGeometry,
    );
    console.error(`Failed to hydrate diff item "${item.filename}":`, error);
  }
}

async function processPendingDiffHydrationTasks(): Promise<void> {
  while (
    activeDiffHydrationCount < diffHydrationWorkerLimit &&
    pendingDiffHydrationTasks.length > 0
  ) {
    const nextTask = pendingDiffHydrationTasks.shift();
    if (!nextTask) {
      return;
    }

    if (nextTask.requestId !== activeLoadSequence || !isDiffMode.value) {
      nextTask.item.hydrationPromise = undefined;
      nextTask.item.isHydrating = false;
      nextTask.resolve();
      continue;
    }

    if (nextTask.item.isHydrated) {
      nextTask.item.hydrationPromise = undefined;
      nextTask.item.isHydrating = false;
      nextTask.resolve();
      continue;
    }

    activeDiffHydrationCount += 1;
    nextTask.item.isHydrating = true;

    void hydrateDiffItemGeometry(nextTask.item, nextTask).finally(() => {
      nextTask.item.isHydrating = false;
      nextTask.item.hydrationPromise = undefined;
      activeDiffHydrationCount -= 1;
      triggerRef(diffItems);
      nextTask.resolve();
      void processPendingDiffHydrationTasks();
    });
  }
}

function ensureDiffItemsHydrated(items: DiffItem[]): Promise<void> {
  if (items.length === 0) {
    return Promise.resolve();
  }

  const context = activeDiffContext;
  if (!context) {
    return Promise.resolve();
  }

  return Promise.all(
    items.map((item) => {
      if (item.isHydrated) {
        return Promise.resolve();
      }

      if (item.hydrationPromise) {
        return item.hydrationPromise;
      }

      const hydrationPromise = new Promise<void>((resolve) => {
        pendingDiffHydrationTasks.push({
          ...context,
          item,
          resolve,
        });
      });

      item.hydrationPromise = hydrationPromise;
      void processPendingDiffHydrationTasks();
      return hydrationPromise;
    }),
  ).then(() => undefined);
}

async function hydrateDiffItemCsg(
  item: DiffItem,
  context: DiffHydrationContext,
): Promise<void> {
  if (item.isCsgHydrated) {
    return;
  }

  if (!canHydrateCsgForItem(item) || !item.oldPath || !item.newPath) {
    item.isCsgHydrated = true;
    return;
  }

  let csgAdded: BufferGeometry | null = null;
  let csgRemoved: BufferGeometry | null = null;
  let csgUnchanged: BufferGeometry | null = null;

  try {
    const [oldBytes, newBytes] = await Promise.all([
      readFileAtSha(context.repoPath, context.baseSha, item.oldPath),
      readFileAtSha(context.repoPath, context.headSha, item.newPath),
    ]);
    const payload = await computeCsgDiffPayload(
      cloneBufferForWorker(oldBytes),
      cloneBufferForWorker(newBytes),
    );

    csgAdded = buildWorkerGeometry(payload.csgAdded);
    csgRemoved = buildWorkerGeometry(payload.csgRemoved);
    csgUnchanged = buildWorkerGeometry(payload.csgUnchanged);

    if (context.requestId !== activeLoadSequence || !isDiffMode.value) {
      disposeOverlayGeometry(csgAdded);
      disposeOverlayGeometry(csgRemoved);
      disposeOverlayGeometry(csgUnchanged);
      return;
    }

    item.csgAdded = csgAdded;
    item.csgRemoved = csgRemoved;
    item.csgUnchanged = csgUnchanged;
    item.isCsgHydrated = true;
  } catch (error) {
    disposeOverlayGeometry(csgAdded);
    disposeOverlayGeometry(csgRemoved);
    disposeOverlayGeometry(csgUnchanged);
    console.error(`Failed to hydrate CSG diff item "${item.filename}":`, error);
  }
}

async function processPendingDiffCsgHydrationTasks(): Promise<void> {
  while (
    activeDiffCsgHydrationCount < diffCsgWorkerLimit &&
    pendingDiffCsgHydrationTasks.length > 0
  ) {
    const nextTask = pendingDiffCsgHydrationTasks.shift();
    if (!nextTask) {
      return;
    }

    if (nextTask.requestId !== activeLoadSequence || !isDiffMode.value) {
      nextTask.item.csgHydrationPromise = undefined;
      nextTask.item.isCsgHydrating = false;
      nextTask.resolve();
      continue;
    }

    if (nextTask.item.isCsgHydrated) {
      nextTask.item.csgHydrationPromise = undefined;
      nextTask.item.isCsgHydrating = false;
      nextTask.resolve();
      continue;
    }

    activeDiffCsgHydrationCount += 1;
    nextTask.item.isCsgHydrating = true;

    void hydrateDiffItemCsg(nextTask.item, nextTask).finally(() => {
      nextTask.item.isCsgHydrating = false;
      nextTask.item.csgHydrationPromise = undefined;
      activeDiffCsgHydrationCount -= 1;
      triggerRef(diffItems);
      nextTask.resolve();
      void processPendingDiffCsgHydrationTasks();
    });
  }
}

function ensureDiffItemsCsgHydrated(items: DiffItem[]): Promise<void> {
  if (items.length === 0) {
    return Promise.resolve();
  }

  const context = activeDiffContext;
  if (!context) {
    return Promise.resolve();
  }

  const csgCandidates = items.filter((item) => canHydrateCsgForItem(item));
  if (csgCandidates.length === 0) {
    return Promise.resolve();
  }

  return Promise.all(
    csgCandidates.map((item) => {
      if (item.isCsgHydrated) {
        return Promise.resolve();
      }

      if (item.csgHydrationPromise) {
        return item.csgHydrationPromise;
      }

      const hydrationPromise = new Promise<void>((resolve) => {
        pendingDiffCsgHydrationTasks.push({
          ...context,
          item,
          resolve,
        });
      });

      item.csgHydrationPromise = hydrationPromise;
      void processPendingDiffCsgHydrationTasks();
      return hydrationPromise;
    }),
  ).then(() => undefined);
}

function clearDiffState(options: { preserveSelection?: boolean } = {}): void {
  activeLoadSequence += 1;
  activeDiffContext = null;
  isLoadingDiff.value = false;
  diffError.value = null;
  diffResult.value = null;
  clearPendingDiffHydrationTasks();
  clearPendingDiffCsgHydrationTasks();
  resetDiffResources();

  if (!options.preserveSelection) {
    selectedBaseSha.value = null;
    selectedHeadSha.value = null;
  }
}

async function loadDiff(projectName: string, baseSha: string, headSha: string): Promise<void> {
  const requestId = ++activeLoadSequence;
  activeDiffContext = null;
  isLoadingDiff.value = true;
  diffError.value = null;
  diffResult.value = null;
  diffViewMode.value = "overlay";
  clearPendingDiffHydrationTasks();
  clearPendingDiffCsgHydrationTasks();
  resetDiffResources();

  try {
    const repoPath = await getProjectDirectory(projectName);
    const diff = await invoke<CommitDiffResult>("get_commit_diff", {
      repoPath,
      baseSha,
      headSha,
    });
    const [baseManifest, headManifest] = await Promise.all([
      readOptionalManifestAtSha(repoPath, baseSha),
      readOptionalManifestAtSha(repoPath, headSha),
    ]);

    const overlayCandidates = collectOverlayCandidates(
      diff,
      baseManifest,
      headManifest,
    );
    const parsedDiffPayload = overlayCandidates.map((candidate) =>
      createDiffItem(baseSha, headSha, candidate),
    );

    if (requestId !== activeLoadSequence || !isDiffMode.value) {
      disposeDiffItemResources(parsedDiffPayload);
      return;
    }

    activeDiffContext = {
      requestId,
      repoPath,
      baseSha,
      headSha,
    };
    diffResult.value = diff;
    await ensureDiffItemsHydrated(parsedDiffPayload.filter((item) => item.visible));

    if (requestId !== activeLoadSequence || !isDiffMode.value) {
      disposeDiffItemResources(parsedDiffPayload);
      return;
    }

    frameDiffItems(parsedDiffPayload);
    await insertDiffItemsInChunks(parsedDiffPayload, requestId);
    void ensureDiffItemsCsgHydrated(parsedDiffPayload.filter((item) => item.visible));
  } catch (error) {
    if (requestId !== activeLoadSequence) {
      return;
    }

    console.error("Failed to load git diff:", error);
    diffError.value = error instanceof Error ? error.message : String(error);
    diffResult.value = null;
    resetDiffResources();
  } finally {
    if (requestId === activeLoadSequence && isLoadingDiff.value) {
      isLoadingDiff.value = false;
    }
  }
}

function setDiffMode(enabled: boolean): void {
  isDiffMode.value = enabled;

  if (!enabled) {
    clearDiffState({ preserveSelection: true });
    if (assembly.value.length > 0) {
      const { frameAssembly } = useStlImport();
      frameAssembly();
    }
  }
}

function setDiffItemVisibility(itemId: string, visible: boolean): void {
  const item = diffItems.value.find((entry) => entry.id === itemId);
  if (!item) {
    return;
  }

  item.visible = visible;

  if (visible) {
    void ensureDiffItemsHydrated([item]);
    void ensureDiffItemsCsgHydrated([item]);
  }

  triggerRef(diffItems);
}

function toggleDiffItemVisibility(itemId: string): void {
  const item = diffItems.value.find((entry) => entry.id === itemId);
  if (!item) {
    return;
  }

  item.visible = !item.visible;

  if (item.visible) {
    void ensureDiffItemsHydrated([item]);
    void ensureDiffItemsCsgHydrated([item]);
  }

  triggerRef(diffItems);
}

function setUnchangedDiffItemVisibility(visible: boolean): void {
  let hasChanges = false;

  for (const item of diffItems.value) {
    if (item.status === "unchanged") {
      item.visible = visible;
      hasChanges = true;
    }
  }

  if (hasChanges) {
    if (visible) {
      void ensureDiffItemsHydrated(
        diffItems.value.filter((item) => item.status === "unchanged"),
      );
      void ensureDiffItemsCsgHydrated(
        diffItems.value.filter((item) => item.status === "unchanged"),
      );
    }

    triggerRef(diffItems);
  }
}

watch(diffOpacity, (value) => {
  const clampedValue = clampDiffOpacity(value);
  if (clampedValue !== value) {
    diffOpacity.value = clampedValue;
    return;
  }

  applyDiffVisualization(diffItems.value);
});

watch(diffViewMode, (mode) => {
  if (mode === "csg") {
    void ensureDiffItemsCsgHydrated(diffItems.value.filter((item) => item.visible));
  }
});

watch(activeProjectName, () => {
  isDiffMode.value = false;
  clearDiffState();
});

export function useGitDiff() {
  return {
    diffError,
    diffFiles: computed(() => diffResult.value?.files ?? []),
    diffManifestEntries: computed(() => diffResult.value?.manifest_diff ?? []),
    diffItems,
    diffOpacity,
    diffResult,
    diffViewMode,
    isDiffMode,
    isLoadingDiff,
    loadDiff,
    selectedBaseSha,
    selectedHeadSha,
    setDiffMode,
    setDiffItemVisibility,
    setUnchangedDiffItemVisibility,
    toggleDiffItemVisibility,
  };
}
