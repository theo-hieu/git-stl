import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { message as showMessage } from "@tauri-apps/plugin-dialog";
import { BaseDirectory, readFile, readTextFile } from "@tauri-apps/plugin-fs";
import { computed, ref } from "vue";
import { activeMeshName, activeProjectName, assembly, selectedItemId } from "../store";
import { useStlImport, type StlImportSource } from "./useStlImport";
import {
  applyManifestToRestoredItems,
  getProjectDirectory,
  MANIFEST_FILE_NAME,
  parseManifest,
  PARTS_DIRECTORY_NAME,
  sanitizeProjectSegment,
} from "./useVersioning";

export interface LocalProjectSummary {
  name: string;
  modifiedAt: number;
}

const isProjectBrowserOpen = ref(false);
const isFetchingProjects = ref(false);
const isLoadingProject = ref(false);
const loadingProjectName = ref<string | null>(null);
const projects = ref<LocalProjectSummary[]>([]);
const searchQuery = ref("");
const browserError = ref<string | null>(null);

const filteredProjects = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) {
    return projects.value;
  }

  return projects.value.filter((project) =>
    project.name.toLowerCase().includes(query),
  );
});

function buildProjectRelativePath(projectName: string, ...segments: string[]): string {
  return ["STL_Viewer_Projects", sanitizeProjectSegment(projectName), ...segments].join(
    "/",
  );
}

async function fetchProjects(): Promise<void> {
  if (isFetchingProjects.value) {
    return;
  }

  isFetchingProjects.value = true;
  browserError.value = null;

  try {
    projects.value = await invoke<LocalProjectSummary[]>("get_local_projects");
  } catch (error) {
    console.error("Failed to fetch local projects:", error);
    browserError.value =
      error instanceof Error ? error.message : "Unable to scan local projects.";
    projects.value = [];
  } finally {
    isFetchingProjects.value = false;
  }
}

async function openBrowser(): Promise<void> {
  searchQuery.value = "";
  isProjectBrowserOpen.value = true;
  await fetchProjects();
}

function closeBrowser(): void {
  if (isLoadingProject.value) {
    return;
  }

  isProjectBrowserOpen.value = false;
}

async function loadProject(projectName: string): Promise<void> {
  if (!projectName || isLoadingProject.value) {
    return;
  }

  const { clearAssembly, frameAssembly, processStlSources } = useStlImport();

  isLoadingProject.value = true;
  loadingProjectName.value = projectName;
  browserError.value = null;

  try {
    const manifest = parseManifest(
      await readTextFile(buildProjectRelativePath(projectName, MANIFEST_FILE_NAME), {
        baseDir: BaseDirectory.AppData,
      }),
    );
    const projectDir = await getProjectDirectory(projectName);

    clearAssembly();

    const stlSources: StlImportSource[] = await Promise.all(
      manifest.items.map(async (manifestItem) => {
        const relativePath = buildProjectRelativePath(
          projectName,
          PARTS_DIRECTORY_NAME,
          manifestItem.fileName,
        );
        const absolutePath = await join(
          projectDir,
          PARTS_DIRECTORY_NAME,
          manifestItem.fileName,
        );
        const fileContents = await readFile(relativePath, {
          baseDir: BaseDirectory.AppData,
        });

        return {
          name: manifestItem.name,
          sourcePath: absolutePath,
          buffer: fileContents.buffer.slice(
            fileContents.byteOffset,
            fileContents.byteOffset + fileContents.byteLength,
          ),
        };
      }),
    );

    const workerLoadedItems = await processStlSources(stlSources, {
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
    isProjectBrowserOpen.value = false;
  } catch (error) {
    console.error(`Failed to load project "${projectName}":`, error);
    browserError.value =
      error instanceof Error ? error.message : `Unable to load "${projectName}".`;
    await showMessage(String(browserError.value), {
      title: "Project load failed",
      kind: "error",
    });
  } finally {
    isLoadingProject.value = false;
    loadingProjectName.value = null;
  }
}

export function useProjectBrowser() {
  return {
    browserError,
    closeProjectBrowser: closeBrowser,
    closeBrowser,
    fetchProjects,
    filteredProjects,
    isFetchingProjects,
    isLoadingProject,
    isProjectBrowserOpen,
    loadProject,
    loadingProjectName,
    openProjectBrowser: openBrowser,
    openBrowser,
    projectBrowserError: browserError,
    projects,
    searchQuery,
  };
}
