import { invoke } from "@tauri-apps/api/core";
import { Box3, MeshStandardMaterial, Vector3, type BufferGeometry } from "three";
import { computed, markRaw, ref, shallowRef, watch } from "vue";
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

export interface DiffMeshOverlay {
  id: string;
  filePath: string;
  name: string;
  status: GitDiffFile["status"];
  oldGeometry: BufferGeometry | null;
  newGeometry: BufferGeometry | null;
  oldMaterial: MeshStandardMaterial | null;
  newMaterial: MeshStandardMaterial | null;
  oldPosition: AssemblyVector3;
  newPosition: AssemblyVector3;
  oldRotation: AssemblyVector3;
  newRotation: AssemblyVector3;
}

export type DiffVisualizationMode = "overlay" | "split";

interface DiffOverlayCandidate {
  id: string;
  name: string;
  status: GitDiffFile["status"];
  oldPath: string | null;
  newPath: string | null;
  oldItem: AssemblyManifestItem | null;
  newItem: AssemblyManifestItem | null;
}

const OLD_DIFF_COLOR = "#ef4444";
const NEW_DIFF_COLOR = "#22c55e";

const textDecoder = new TextDecoder();
const isDiffMode = ref(false);
const isLoadingDiff = ref(false);
const diffError = ref<string | null>(null);
const diffResult = ref<CommitDiffResult | null>(null);
const diffOverlays = shallowRef<DiffMeshOverlay[]>([]);
const diffVisualizationMode = ref<DiffVisualizationMode>("overlay");
const diffOpacity = ref(0.5);
const diffSplitOffset = ref(0);
const selectedBaseSha = ref<string | null>(null);
const selectedHeadSha = ref<string | null>(null);

let activeLoadSequence = 0;

function createDiffMaterial(color: string): MeshStandardMaterial {
  return markRaw(
    new MeshStandardMaterial({
      color,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  ) as MeshStandardMaterial;
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

function disposeOverlayResources(overlays: DiffMeshOverlay[]): void {
  for (const overlay of overlays) {
    overlay.oldMaterial?.dispose();
    overlay.newMaterial?.dispose();
    disposeOverlayGeometry(overlay.oldGeometry);
    disposeOverlayGeometry(overlay.newGeometry);
  }
}

function setMaterialOpacity(
  material: MeshStandardMaterial | null,
  opacity: number,
): void {
  if (!material) {
    return;
  }

  material.opacity = opacity;
  material.visible = opacity > 0.001;
}

function applyDiffVisualization(overlays: DiffMeshOverlay[]): void {
  const clampedOpacity = clampDiffOpacity(diffOpacity.value);
  const baseOpacity =
    diffVisualizationMode.value === "overlay" ? 1 - clampedOpacity : 0.82;
  const headOpacity =
    diffVisualizationMode.value === "overlay" ? clampedOpacity : 0.82;

  for (const overlay of overlays) {
    setMaterialOpacity(overlay.oldMaterial, baseOpacity);
    setMaterialOpacity(overlay.newMaterial, headOpacity);
  }
}

function resetDiffResources(): void {
  if (diffOverlays.value.length > 0) {
    disposeOverlayResources(diffOverlays.value);
    diffOverlays.value = [];
  }

  diffSplitOffset.value = 0;
}

function getDisplayPosition(
  position: AssemblyVector3,
  side: "base" | "head",
  splitOffset: number,
): AssemblyVector3 {
  if (splitOffset === 0) {
    return position;
  }

  return [
    position[0] + (side === "base" ? -splitOffset : splitOffset),
    position[1],
    position[2],
  ];
}

function frameDiffOverlays(overlays: DiffMeshOverlay[]): void {
  if (overlays.length === 0) {
    diffSplitOffset.value = 0;
    return;
  }

  const sourceBox = new Box3();
  const masterBox = new Box3();
  const worldBox = new Box3();
  const offset = new Vector3();

  for (const overlay of overlays) {
    const snapshots = [
      {
        geometry: overlay.oldGeometry,
        position: overlay.oldPosition,
      },
      {
        geometry: overlay.newGeometry,
        position: overlay.newPosition,
      },
    ];

    for (const snapshot of snapshots) {
      if (!snapshot.geometry) {
        continue;
      }

      snapshot.geometry.computeBoundingBox();
      if (!snapshot.geometry.boundingBox) {
        continue;
      }

      worldBox.copy(snapshot.geometry.boundingBox);
      offset.set(snapshot.position[0], snapshot.position[1], snapshot.position[2]);
      worldBox.translate(offset);
      sourceBox.union(worldBox);
    }
  }

  const sourceSize = new Vector3();
  sourceBox.getSize(sourceSize);
  const sourceMaxDimension = Math.max(sourceSize.x, sourceSize.y, sourceSize.z) || 1;
  const splitOffset =
    diffVisualizationMode.value === "split"
      ? Math.max(sourceMaxDimension * 0.6, 10)
      : 0;
  diffSplitOffset.value = splitOffset;

  for (const overlay of overlays) {
    const snapshots = [
      {
        geometry: overlay.oldGeometry,
        position: getDisplayPosition(overlay.oldPosition, "base", splitOffset),
      },
      {
        geometry: overlay.newGeometry,
        position: getDisplayPosition(overlay.newPosition, "head", splitOffset),
      },
    ];

    for (const snapshot of snapshots) {
      if (!snapshot.geometry) {
        continue;
      }

      snapshot.geometry.computeBoundingBox();
      if (!snapshot.geometry.boundingBox) {
        continue;
      }

      worldBox.copy(snapshot.geometry.boundingBox);
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

function buildPartRepoPath(fileName: string): string {
  return `${PARTS_DIRECTORY_NAME}/${fileName}`;
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
    !vectorsEqual(oldItem.position, newItem.position) ||
    !vectorsEqual(oldItem.rotation, newItem.rotation)
  );
}

function collectManifestOverlayCandidates(
  baseManifest: AssemblyManifest | null,
  headManifest: AssemblyManifest | null,
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
    if (!manifestItemsDiffer(oldItem, newItem)) {
      continue;
    }

    const fallbackPath =
      newItem?.fileName ?? oldItem?.fileName ?? `manifest-item-${itemId}.stl`;
    candidates.push({
      id: `item:${itemId}`,
      name: buildOverlayName(fallbackPath, oldItem, newItem),
      status: !oldItem ? "added" : !newItem ? "deleted" : "modified",
      oldPath: oldItem ? buildPartRepoPath(oldItem.fileName) : null,
      newPath: newItem ? buildPartRepoPath(newItem.fileName) : null,
      oldItem,
      newItem,
    });
  }

  return candidates;
}

function collectOverlayCandidates(
  diff: CommitDiffResult,
  baseManifest: AssemblyManifest | null,
  headManifest: AssemblyManifest | null,
): DiffOverlayCandidate[] {
  const candidates = new Map<string, DiffOverlayCandidate>();

  for (const candidate of collectManifestOverlayCandidates(baseManifest, headManifest)) {
    candidates.set(candidate.id, candidate);
  }

  for (const file of diff.files.filter((entry) => entry.is_stl)) {
    const oldItem = resolveManifestItem(baseManifest, file.old_path ?? file.path);
    const newItem = resolveManifestItem(headManifest, file.new_path ?? file.path);
    const candidateId =
      oldItem?.id ?? newItem?.id ?? `file:${file.old_path ?? file.new_path ?? file.path}`;

    if (candidates.has(candidateId)) {
      continue;
    }

    candidates.set(candidateId, {
      id: candidateId,
      name: buildOverlayName(file.path, oldItem, newItem),
      status: file.status,
      oldPath: file.old_path ?? file.path,
      newPath: file.new_path ?? file.path,
      oldItem,
      newItem,
    });
  }

  return [...candidates.values()];
}

async function buildOverlay(
  repoPath: string,
  baseSha: string,
  headSha: string,
  candidate: DiffOverlayCandidate,
): Promise<DiffMeshOverlay> {
  const [oldGeometry, newGeometry] = await Promise.all([
    candidate.status === "added"
      ? Promise.resolve(null)
      : parseOverlayGeometry(repoPath, baseSha, candidate.oldPath),
    candidate.status === "deleted"
      ? Promise.resolve(null)
      : parseOverlayGeometry(repoPath, headSha, candidate.newPath),
  ]);

  return {
    id: `${baseSha}:${headSha}:${candidate.id}`,
    filePath: candidate.newPath ?? candidate.oldPath ?? candidate.id,
    name: candidate.name,
    status: candidate.status,
    oldGeometry,
    newGeometry,
    oldMaterial: oldGeometry ? createDiffMaterial(OLD_DIFF_COLOR) : null,
    newMaterial: newGeometry ? createDiffMaterial(NEW_DIFF_COLOR) : null,
    oldPosition: cloneVector3(candidate.oldItem?.position),
    newPosition: cloneVector3(candidate.newItem?.position),
    oldRotation: cloneVector3(candidate.oldItem?.rotation),
    newRotation: cloneVector3(candidate.newItem?.rotation),
  };
}

function clearDiffState(options: { preserveSelection?: boolean } = {}): void {
  activeLoadSequence += 1;
  isLoadingDiff.value = false;
  diffError.value = null;
  diffResult.value = null;
  resetDiffResources();

  if (!options.preserveSelection) {
    selectedBaseSha.value = null;
    selectedHeadSha.value = null;
  }
}

async function loadDiff(projectName: string, baseSha: string, headSha: string): Promise<void> {
  const requestId = ++activeLoadSequence;
  isLoadingDiff.value = true;
  diffError.value = null;
  diffResult.value = null;
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
    const overlays = await Promise.all(
      overlayCandidates.map((candidate) =>
        buildOverlay(repoPath, baseSha, headSha, candidate),
      ),
    );

    if (requestId !== activeLoadSequence || !isDiffMode.value) {
      disposeOverlayResources(overlays);
      return;
    }

    diffResult.value = diff;
    diffOverlays.value = overlays;
    applyDiffVisualization(overlays);
    frameDiffOverlays(overlays);
  } catch (error) {
    if (requestId !== activeLoadSequence) {
      return;
    }

    console.error("Failed to load git diff:", error);
    diffError.value = error instanceof Error ? error.message : String(error);
    diffResult.value = null;
    resetDiffResources();
  } finally {
    if (requestId === activeLoadSequence) {
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

watch(diffOpacity, (value) => {
  const clampedValue = clampDiffOpacity(value);
  if (clampedValue !== value) {
    diffOpacity.value = clampedValue;
    return;
  }

  applyDiffVisualization(diffOverlays.value);
});

watch(diffVisualizationMode, () => {
  applyDiffVisualization(diffOverlays.value);

  if (isDiffMode.value && diffOverlays.value.length > 0) {
    frameDiffOverlays(diffOverlays.value);
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
    diffOpacity,
    diffOverlays,
    diffResult,
    diffSplitOffset,
    diffVisualizationMode,
    isDiffMode,
    isLoadingDiff,
    loadDiff,
    selectedBaseSha,
    selectedHeadSha,
    setDiffMode,
  };
}
