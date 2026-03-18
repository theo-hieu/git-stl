import { appDataDir, join } from "@tauri-apps/api/path";
import {
  exists,
  mkdir,
  readDir,
  readFile,
  readTextFile,
  remove,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { Command } from "@tauri-apps/plugin-shell";
import { Mesh, MeshStandardMaterial } from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { computed, ref, watch } from "vue";
import { useStlImport } from "./useStlImport";
import {
  activeMeshName,
  activeProjectName,
  assembly,
  createAssemblyItem,
  selectedItemId,
  type AssemblyItem,
  type AssemblyVector3,
} from "../store";

const MANIFEST_FILE_NAME = "manifest.json";
const PARTS_DIRECTORY_NAME = "parts";

export interface AssemblyManifestItem {
  id: string;
  name: string;
  fileName: string;
  position: AssemblyVector3;
  rotation: AssemblyVector3;
  visible: boolean;
}

export interface AssemblyManifest {
  version: 1;
  projectName: string;
  savedAt: string;
  selectedItemId: string | null;
  items: AssemblyManifestItem[];
}

const commitHistory = ref<string[]>([]);

function sanitizeProjectSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9-_]+/g, "_") || "assembly-project";
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

  const { id, name, fileName, position, rotation, visible } = value;
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
    visible,
  };
}

function parseManifest(raw: string): AssemblyManifest {
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

function exportAssemblyItem(item: AssemblyItem): string {
  const exporter = new STLExporter();
  const mesh = new Mesh(item.geometry, new MeshStandardMaterial());
  const exportResult = exporter.parse(mesh, { binary: false });

  if (typeof exportResult !== "string") {
    throw new Error(`Expected text STL export for "${item.name}".`);
  }

  return exportResult;
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
      visible: item.visible,
    })),
  };
}

async function getProjectDirectory(projectName: string): Promise<string> {
  const appDataDirPath = await appDataDir();
  return join(
    appDataDirPath,
    "STL_Viewer_Projects",
    sanitizeProjectSegment(projectName),
  );
}

async function ensureProjectRepository(projectDir: string): Promise<void> {
  if (!(await exists(projectDir))) {
    await mkdir(projectDir, { recursive: true });
  }

  await Command.create("git", ["init"], { cwd: projectDir }).execute();
  await Command.create(
    "git",
    ["config", "user.name", "STL Viewer App"],
    { cwd: projectDir },
  ).execute();
  await Command.create(
    "git",
    ["config", "user.email", "stl@viewer.local"],
    { cwd: projectDir },
  ).execute();
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

    const logOutput = await Command.create(
      "git",
      ["log", "--pretty=format:%h - %an, %ar : %s"],
      { cwd: projectDir },
    ).execute();

    if (logOutput.code === 0) {
      commitHistory.value = logOutput.stdout.split("\n").filter(Boolean);
      return;
    }

    commitHistory.value = [];
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
    await writeTextFile(filePath, exportAssemblyItem(sourceItem));
  }

  const manifestPath = await join(projectDir, MANIFEST_FILE_NAME);
  await writeTextFile(manifestPath, JSON.stringify(manifest, null, 2));
}

async function loadManifestAssemblyItem(
  projectDir: string,
  manifestItem: AssemblyManifestItem,
): Promise<AssemblyItem> {
  const filePath = await join(projectDir, PARTS_DIRECTORY_NAME, manifestItem.fileName);
  const fileContents = await readFile(filePath);
  const buffer = fileContents.buffer.slice(
    fileContents.byteOffset,
    fileContents.byteOffset + fileContents.byteLength,
  );

  const loader = new STLLoader();
  const geometry = loader.parse(buffer);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return createAssemblyItem({
    id: manifestItem.id,
    name: manifestItem.name,
    sourcePath: filePath,
    geometry,
    position: [...manifestItem.position] as AssemblyVector3,
    rotation: [...manifestItem.rotation] as AssemblyVector3,
    visible: manifestItem.visible,
  });
}

export function useVersioning() {
  const { frameAssembly, releaseAssemblyItemGeometry } = useStlImport();

  const versionTargetName = computed(
    () =>
      activeProjectName.value ??
      assembly.value[0]?.name.replace(/\.stl$/i, "") ??
      null,
  );

  watch(
    versionTargetName,
    async (projectName) => {
      await fetchHistoryForProject(projectName);
    },
    { immediate: true },
  );

  async function saveVersion(): Promise<void> {
    const projectName = versionTargetName.value;
    if (!projectName || assembly.value.length === 0) {
      return;
    }

    try {
      const projectDir = await getProjectDirectory(projectName);
      await ensureProjectRepository(projectDir);

      const manifest = buildManifest(projectName);
      await syncProjectFiles(projectDir, manifest);

      await Command.create("git", ["add", "."], { cwd: projectDir }).execute();
      await Command.create(
        "git",
        ["commit", "-m", `Assembly saved at ${new Date().toLocaleString()}`],
        { cwd: projectDir },
      ).execute();

      await fetchHistoryForProject(projectName);
    } catch (error) {
      console.error("Failed to save assembly version:", error);
    }
  }

  async function checkoutCommit(commitLabel: string): Promise<void> {
    const projectName = versionTargetName.value;
    const hash = commitLabel.split(" ")[0];

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
      const restoredItems = await Promise.all(
        manifest.items.map((item) => loadManifestAssemblyItem(projectDir, item)),
      );

      for (const existingItem of assembly.value) {
        releaseAssemblyItemGeometry(existingItem);
      }

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
    saveVersion,
    versionTargetName,
  };
}
