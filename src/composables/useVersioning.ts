import { invoke } from "@tauri-apps/api/core";
import { message as showMessage } from "@tauri-apps/plugin-dialog";
import { appDataDir, join } from "@tauri-apps/api/path";
import {
  exists,
  mkdir,
  readFile,
  readDir,
  readTextFile,
  remove,
  writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { Command } from "@tauri-apps/plugin-shell";
import { Mesh, MeshStandardMaterial } from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { computed, ref, watch } from "vue";
import { useStlImport } from "./useStlImport";
import {
  activeMeshName,
  activeProjectName,
  assembly,
  selectedItemId,
  type AssemblyItem,
  type AssemblyVector3,
} from "../store";

export const MANIFEST_FILE_NAME = "manifest.json";
export const PARTS_DIRECTORY_NAME = "parts";

export interface AssemblyManifestItem {
  id: string;
  name: string;
  fileName: string;
  position: AssemblyVector3;
  rotation: AssemblyVector3;
  scale: AssemblyVector3;
  visible: boolean;
}

export interface AssemblyManifest {
  version: 1;
  projectName: string;
  savedAt: string;
  selectedItemId: string | null;
  items: AssemblyManifestItem[];
}

export interface CommitHistoryEntry {
  sha: string;
  short_sha: string;
  summary: string;
  author: string;
  time: number;
  label: string;
}

const commitHistory = ref<CommitHistoryEntry[]>([]);
const isSavingVersion = ref(false);

export function sanitizeProjectSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9-_]+/g, "_");
  return sanitized.replace(/_/g, "") ? sanitized : "assembly-project";
}

function normalizeProjectName(projectName: string): string {
  return projectName.trim();
}

function createPartFileName(item: AssemblyItem): string {
  const stem = sanitizeProjectSegment(item.name.replace(/\.stl$/i, ""));
  return `${stem}-${item.id}.stl`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseVector3(value: unknown, label: string): AssemblyVector3 {
  if (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((entry) => typeof entry === "number")
  ) {
    return [value[0], value[1], value[2]];
  }

  throw new Error(`Invalid manifest vector for "${label}".`);
}

function parseManifestItem(value: unknown): AssemblyManifestItem {
  if (!isRecord(value)) {
    throw new Error("Manifest item is not an object.");
  }

  const { id, name, fileName, position, rotation, scale, visible } = value;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof fileName !== "string" ||
    typeof visible !== "boolean"
  ) {
    throw new Error("Manifest item fields are invalid.");
  }

  return {
    id,
    name,
    fileName,
    position: parseVector3(position, `${name}.position`),
    rotation: parseVector3(rotation, `${name}.rotation`),
    scale: scale === undefined ? [1, 1, 1] : parseVector3(scale, `${name}.scale`),
    visible,
  };
}

export function parseManifest(raw: string): AssemblyManifest {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("Manifest JSON root is invalid.");
  }

  const { version, projectName, savedAt, selectedItemId: parsedSelectedItemId, items } =
    parsed;

  if (version !== 1 || typeof projectName !== "string" || typeof savedAt !== "string") {
    throw new Error("Manifest header is invalid.");
  }

  if (
    parsedSelectedItemId !== null &&
    typeof parsedSelectedItemId !== "string"
  ) {
    throw new Error("Manifest selectedItemId is invalid.");
  }

  if (!Array.isArray(items)) {
    throw new Error("Manifest items must be an array.");
  }

  return {
    version: 1,
    projectName,
    savedAt,
    selectedItemId: parsedSelectedItemId,
    items: items.map((item) => parseManifestItem(item)),
  };
}

function getPathKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function exportAssemblyItem(item: AssemblyItem): Uint8Array {
  const exporter = new STLExporter();
  const material = new MeshStandardMaterial();
  const mesh = new Mesh(item.geometry, material);
  const exportResult = (() => {
    try {
      return exporter.parse(mesh, { binary: true });
    } finally {
      material.dispose();
    }
  })();

  if (!(exportResult instanceof DataView)) {
    throw new Error(`Expected binary STL export for "${item.name}".`);
  }

  return new Uint8Array(
    exportResult.buffer,
    exportResult.byteOffset,
    exportResult.byteLength,
  );
}

function buildManifest(projectName: string): AssemblyManifest {
  return {
    version: 1,
    projectName,
    savedAt: new Date().toISOString(),
    selectedItemId: selectedItemId.value,
    items: assembly.value.map((item) => ({
      id: item.id,
      name: item.name,
      fileName: createPartFileName(item),
      position: [...item.position] as AssemblyVector3,
      rotation: [...item.rotation] as AssemblyVector3,
      scale: [...item.scale] as AssemblyVector3,
      visible: item.visible,
    })),
  };
}

export async function getProjectDirectory(projectName: string): Promise<string> {
  const appDataDirPath = await appDataDir();
  return join(
    appDataDirPath,
    "STL_Viewer_Projects",
    sanitizeProjectSegment(projectName),
  );
}

async function fetchHistoryForProject(projectName: string | null): Promise<void> {
  if (!projectName) {
    commitHistory.value = [];
    return;
  }

  try {
    const projectDir = await getProjectDirectory(projectName);
    if (!(await exists(projectDir))) {
      commitHistory.value = [];
      return;
    }

    const gitDir = await join(projectDir, ".git");
    if (!(await exists(gitDir))) {
      commitHistory.value = [];
      return;
    }

    commitHistory.value = await invoke<CommitHistoryEntry[]>("get_commit_history", {
      repoPath: projectDir,
    });
  } catch (error) {
    console.error("Failed to fetch version history:", error);
    commitHistory.value = [];
  }
}

async function syncProjectFiles(
  projectDir: string,
  manifest: AssemblyManifest,
): Promise<void> {
  const partsDir = await join(projectDir, PARTS_DIRECTORY_NAME);
  if (!(await exists(partsDir))) {
    await mkdir(partsDir, { recursive: true });
  }

  const desiredFiles = new Set(manifest.items.map((item) => item.fileName));
  const existingEntries = await readDir(partsDir);

  for (const entry of existingEntries) {
    if (entry.isFile && !desiredFiles.has(entry.name)) {
      const stalePath = await join(partsDir, entry.name);
      await remove(stalePath);
    }
  }

  for (const manifestItem of manifest.items) {
    const sourceItem = assembly.value.find((item) => item.id === manifestItem.id);
    if (!sourceItem) {
      continue;
    }

    const filePath = await join(partsDir, manifestItem.fileName);
    const fileExists = await exists(filePath);

    if (sourceItem.geometryModified) {
      await writeFile(filePath, exportAssemblyItem(sourceItem));
      sourceItem.geometryModified = false;
    } else if (!fileExists) {
      await writeFile(filePath, await readFile(sourceItem.sourcePath));
    }
  }

  const manifestPath = await join(projectDir, MANIFEST_FILE_NAME);
  await writeTextFile(manifestPath, JSON.stringify(manifest, null, 2));
}

async function getManifestFilePaths(manifest: AssemblyManifest, projectDir: string) {
  return Promise.all(
    manifest.items.map((item) => join(projectDir, PARTS_DIRECTORY_NAME, item.fileName)),
  );
}

export async function applyManifestToRestoredItems(
  manifest: AssemblyManifest,
  projectDir: string,
  restoredItems: AssemblyItem[],
): Promise<AssemblyItem[]> {
  const itemsBySourcePath = new Map(
    restoredItems.map((item) => [getPathKey(item.sourcePath), item]),
  );
  const orderedItems: AssemblyItem[] = [];

  for (const manifestItem of manifest.items) {
    const filePath = await join(projectDir, PARTS_DIRECTORY_NAME, manifestItem.fileName);
    const restoredItem = itemsBySourcePath.get(getPathKey(filePath));

    if (!restoredItem) {
      console.warn(`Restored manifest item "${manifestItem.name}" was not loaded.`);
      continue;
    }

    restoredItem.id = manifestItem.id;
    restoredItem.name = manifestItem.name;
    restoredItem.position = [...manifestItem.position] as AssemblyVector3;
    restoredItem.rotation = [...manifestItem.rotation] as AssemblyVector3;
    restoredItem.scale = [...manifestItem.scale] as AssemblyVector3;
    restoredItem.visible = manifestItem.visible;
    restoredItem.geometryModified = false;
    orderedItems.push(restoredItem);
  }

  return orderedItems;
}

export function useVersioning() {
  const { clearAssembly, frameAssembly, processStlFiles } = useStlImport();

  const suggestedProjectName = computed(
    () => assembly.value[0]?.name.replace(/\.stl$/i, "") ?? "",
  );
  const versionTargetName = computed(() => activeProjectName.value);

  watch(
    activeProjectName,
    async (projectName) => {
      await fetchHistoryForProject(projectName);
    },
    { immediate: true },
  );

  async function commitProjectSnapshot(
    projectName: string,
    message: string,
  ): Promise<void> {
    const normalizedProjectName = normalizeProjectName(projectName);

    if (!normalizedProjectName) {
      throw new Error("A project name is required.");
    }

    const normalizedMessage = message.trim() || `Assembly saved at ${new Date().toLocaleString()}`;
    const projectDir = await getProjectDirectory(normalizedProjectName);
    const manifest = buildManifest(normalizedProjectName);

    await syncProjectFiles(projectDir, manifest);
    await invoke<boolean>("commit_assembly", {
      projectName: normalizedProjectName,
      message: normalizedMessage,
    });

    activeProjectName.value = normalizedProjectName;
    await fetchHistoryForProject(normalizedProjectName);
  }

  async function saveAsNewProject(projectName: string): Promise<void> {
    const normalizedProjectName = normalizeProjectName(projectName);

    if (!normalizedProjectName || assembly.value.length === 0 || isSavingVersion.value) {
      return;
    }

    isSavingVersion.value = true;

    try {
      const projectDir = await getProjectDirectory(normalizedProjectName);
      if (await exists(projectDir)) {
        throw new Error(`A project named "${normalizedProjectName}" already exists.`);
      }

      await mkdir(projectDir, { recursive: true });
      await commitProjectSnapshot(normalizedProjectName, "Initial project import");
    } catch (error) {
      console.error("Failed to save new project:", error);
      await showMessage(String(error), {
        title: "Project save failed",
        kind: "error",
      });
    } finally {
      isSavingVersion.value = false;
    }
  }

  async function saveVersion(message: string): Promise<void> {
    const projectName = activeProjectName.value;

    if (!projectName || isSavingVersion.value) {
      return;
    }

    isSavingVersion.value = true;

    try {
      const projectDir = await getProjectDirectory(projectName);
      if (!(await exists(projectDir))) {
        throw new Error(
          `The project directory for "${projectName}" could not be found.`,
        );
      }

      await commitProjectSnapshot(projectName, message);
    } catch (error) {
      console.error("Failed to save assembly version:", error);
      await showMessage(String(error), {
        title: "Save failed",
        kind: "error",
      });
    } finally {
      isSavingVersion.value = false;
    }
  }

  async function checkoutCommit(hash: string): Promise<void> {
    const projectName = versionTargetName.value;

    if (!projectName || !hash) {
      return;
    }

    try {
      const projectDir = await getProjectDirectory(projectName);
      const checkoutOutput = await Command.create(
        "git",
        ["checkout", hash, "--", "."],
        { cwd: projectDir },
      ).execute();

      if (checkoutOutput.code !== 0) {
        throw new Error(checkoutOutput.stderr || "Unknown git checkout error.");
      }

      const manifestPath = await join(projectDir, MANIFEST_FILE_NAME);
      const manifest = parseManifest(await readTextFile(manifestPath));
      const restoredPaths = await getManifestFilePaths(manifest, projectDir);

      clearAssembly();

      // Wait for the worker batch to fully materialize geometry before restoring
      // manifest-authored ids, transforms, and visibility state.
      const workerLoadedItems = await processStlFiles(restoredPaths, {
        frameOnComplete: false,
      });
      const restoredItems = await applyManifestToRestoredItems(
        manifest,
        projectDir,
        workerLoadedItems,
      );

      assembly.value = restoredItems;
      activeProjectName.value = manifest.projectName;
      selectedItemId.value = restoredItems.some(
        (item) => item.id === manifest.selectedItemId,
      )
        ? manifest.selectedItemId
        : restoredItems[0]?.id ?? null;
      activeMeshName.value =
        restoredItems.find((item) => item.id === selectedItemId.value)?.name ??
        restoredItems[restoredItems.length - 1]?.name ??
        null;

      frameAssembly();
      await fetchHistoryForProject(manifest.projectName);
    } catch (error) {
      console.error("Failed to checkout assembly version:", error);
    }
  }

  return {
    checkoutCommit,
    commitHistory,
    isSavingVersion,
    saveAsNewProject,
    saveVersion,
    suggestedProjectName,
    versionTargetName,
  };
}
