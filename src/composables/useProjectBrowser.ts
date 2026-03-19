import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { message as showMessage } from "@tauri-apps/plugin-dialog";
import { BaseDirectory, readFile, readTextFile, remove } from "@tauri-apps/plugin-fs";
import { computed, ref } from "vue";
import {
  activeMeshName,
  activeProjectName,
  assembly,
  cameraPosition,
  controlsTarget,
  defaultCameraPosition,
  defaultControlsTarget,
  isWireframe,
  scaleX,
  scaleY,
  scaleZ,
  selectedItemId,
  type AssemblyVector3,
} from "../store";
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
  thumbnailPath?: string | null;
  thumbnailSrc?: string | null;
}

function revokeThumbnailUrls(items: LocalProjectSummary[]): void {
  for (const project of items) {
    if (project.thumbnailSrc?.startsWith("blob:")) {
      URL.revokeObjectURL(project.thumbnailSrc);
    }
  }
}

async function resolveThumbnailSrc(
  project: LocalProjectSummary,
): Promise<string | null> {
  if (!project.thumbnailPath) {
    return null;
  }

  try {
    const bytes = await readFile(buildProjectRelativePath(project.name, "thumbnail.png"), {
      baseDir: BaseDirectory.AppData,
    });
    const blob = new Blob([bytes], { type: "image/png" });
    return URL.createObjectURL(blob);
  } catch (error) {
    console.warn(`Failed to load thumbnail for "${project.name}":`, error);
    return null;
  }
}

const isProjectBrowserOpen = ref(false);
const isFetchingProjects = ref(false);
const isLoadingProject = ref(false);
const isDeletingProject = ref(false);
const loadingProjectName = ref<string | null>(null);
const deletingProjectName = ref<string | null>(null);
const pendingDeletionProject = ref<LocalProjectSummary | null>(null);
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
    const localProjects = await invoke<LocalProjectSummary[]>("get_local_projects");
    const hydratedProjects = await Promise.all(
      localProjects.map(async (project) => ({
        ...project,
        thumbnailSrc: await resolveThumbnailSrc(project),
      })),
    );
    revokeThumbnailUrls(projects.value);
    projects.value = hydratedProjects;
  } catch (error) {
    console.error("Failed to fetch local projects:", error);
    browserError.value =
      error instanceof Error ? error.message : "Unable to scan local projects.";
    revokeThumbnailUrls(projects.value);
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
  if (isLoadingProject.value || isDeletingProject.value) {
    return;
  }

  isProjectBrowserOpen.value = false;
  pendingDeletionProject.value = null;
}

function requestProjectDeletion(project: LocalProjectSummary): void {
  if (isLoadingProject.value || isDeletingProject.value) {
    return;
  }

  pendingDeletionProject.value = project;
}

function cancelProjectDeletion(): void {
  if (isDeletingProject.value) {
    return;
  }

  pendingDeletionProject.value = null;
}

function resetViewerSession(): void {
  const { clearAssembly } = useStlImport();

  clearAssembly();
  activeProjectName.value = null;
  activeMeshName.value = null;
  selectedItemId.value = null;
  isWireframe.value = false;
  scaleX.value = 1;
  scaleY.value = 1;
  scaleZ.value = 1;
  cameraPosition.value = [...defaultCameraPosition] as AssemblyVector3;
  controlsTarget.value = [...defaultControlsTarget] as AssemblyVector3;
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

async function confirmProjectDeletion(): Promise<void> {
  const project = pendingDeletionProject.value;

  if (!project || isDeletingProject.value || isLoadingProject.value) {
    return;
  }

  isDeletingProject.value = true;
  deletingProjectName.value = project.name;
  browserError.value = null;

  try {
    await remove(buildProjectRelativePath(project.name), {
      baseDir: BaseDirectory.AppData,
      recursive: true,
    });

    if (activeProjectName.value === project.name) {
      resetViewerSession();
    }

    revokeThumbnailUrls(
      projects.value.filter((entry) => entry.name === project.name),
    );
    projects.value = projects.value.filter(
      (entry) => entry.name !== project.name,
    );
    pendingDeletionProject.value = null;
  } catch (error) {
    console.error(`Failed to delete project "${project.name}":`, error);
    browserError.value =
      error instanceof Error ? error.message : `Unable to delete "${project.name}".`;
    await showMessage(String(browserError.value), {
      title: "Project delete failed",
      kind: "error",
    });
  } finally {
    isDeletingProject.value = false;
    deletingProjectName.value = null;
  }
}

export function useProjectBrowser() {
  return {
    browserError,
    cancelProjectDeletion,
    closeProjectBrowser: closeBrowser,
    closeBrowser,
    confirmProjectDeletion,
    deletingProjectName,
    fetchProjects,
    filteredProjects,
    isDeletingProject,
    isFetchingProjects,
    isLoadingProject,
    isProjectBrowserOpen,
    loadProject,
    loadingProjectName,
    openProjectBrowser: openBrowser,
    openBrowser,
    pendingDeletionProject,
    projectBrowserError: browserError,
    projects,
    requestProjectDeletion,
    searchQuery,
  };
}
