<template>
  <div class="sidebar">
    <h2>{{ sessionTitle }}</h2>
    <p>{{ sessionModeLabel }}</p>

    <div class="primary-actions">
      <button @click="openFiles" class="action-btn" :disabled="isImporting || isLoadingProject">
        {{ isImporting ? "Importing..." : "Import Assembly (Multi-Select)" }}
      </button>

      <button
        @click="openProjectBrowser"
        class="action-btn browse-btn"
        :disabled="isImporting || isLoadingProject"
      >
        {{ isLoadingProject ? "Opening Project..." : "Open Project" }}
      </button>
    </div>

    <div v-if="isImporting" class="progress-container">
      <progress :max="totalFilesToLoad" :value="filesLoaded"></progress>
      <span class="progress-text">
        {{ filesLoaded }} / {{ totalFilesToLoad }} Parts Loaded
      </span>
    </div>

    <div v-if="assembly.length > 0" class="file-info">
      <div class="view-options">
        <label>
          <input type="checkbox" v-model="isWireframe" />
          Wireframe Mode
        </label>
      </div>

      <p>
        <strong>{{ assembly.length }} mesh(es) loaded</strong><br />
        <span class="dim">Project: {{ displayedProjectName }}</span><br />
        <span class="dim">Mode: {{ sessionModeLabel }}</span><br />
        <span class="dim">Last Imported: {{ activeMeshName ?? "None" }}</span><br />
        <span class="dim">Selected Part: {{ selectedPartName ?? "None" }}</span>
      </p>

      <div class="versioning-section">
        <h3>Versioning</h3>

        <template v-if="isProjectMode">
          <label class="text-field">
            <span class="field-label">Commit Message</span>
            <input
              v-model="commitMessage"
              type="text"
              class="text-input"
              placeholder="Describe this assembly change"
            />
          </label>

          <button
            @click="handleSaveVersion"
            class="action-btn save-btn"
            :disabled="isSavingVersion"
          >
            {{ isSavingVersion ? "Saving Version..." : "Save Version" }}
          </button>
        </template>

        <template v-else>
          <p class="dim">
            Version history unlocks after this session is saved into its own project
            directory.
          </p>

          <label class="text-field">
            <span class="field-label">Project Name</span>
            <input
              v-model="newProjectName"
              type="text"
              class="text-input"
              placeholder="Enter a project name"
            />
          </label>

          <button
            @click="handleSaveAsNewProject"
            class="action-btn save-btn"
            :disabled="newProjectName.trim().length === 0 || isSavingVersion"
          >
            {{ isSavingVersion ? "Saving Project..." : "Save as New Project" }}
          </button>
        </template>
      </div>

      <button
        @click="prepareWasm"
        class="action-btn wasm-btn"
        :disabled="!debugTargetName"
      >
        Extract Vertices (Wasm Prep)
      </button>

      <div class="scale-controls">
        <h3>Scale Assembly</h3>
        <div class="scale-inputs">
          <label>
            X
            <input type="number" v-model.number="scaleX" step="0.1" min="0.01" />
          </label>
          <label>
            Y
            <input type="number" v-model.number="scaleY" step="0.1" min="0.01" />
          </label>
          <label>
            Z
            <input type="number" v-model.number="scaleZ" step="0.1" min="0.01" />
          </label>
        </div>
        <button
          @click="scaleAssembly"
          class="action-btn scale-btn"
          :disabled="isScaling"
        >
          {{ isScaling ? "Scaling..." : "Scale Assembly" }}
        </button>
      </div>

      <div class="assembly-tree">
        <h3>Assembly Tree</h3>
        <ul class="part-list">
          <li
            v-for="part in assembly"
            :key="part.id"
            class="part-item"
            :class="{ selected: part.id === selectedItemId }"
            @click="selectItem(part.id)"
          >
            <div class="part-header">
              <label
                class="visibility-toggle"
                :title="part.visible ? 'Hide part' : 'Show part'"
                @click.stop
              >
                <input
                  type="checkbox"
                  :checked="part.visible"
                  @change="setPartVisibility(part.id, $event)"
                />
                Show
              </label>

              <span class="part-name">{{ part.name }}</span>

              <button
                class="delete-btn"
                title="Remove part"
                @click.stop="removePart(part.id)"
              >
                Remove
              </button>
            </div>

            <div class="part-coords">
              <label>
                X
                <input
                  type="number"
                  :value="part.position[0]"
                  step="1"
                  class="coord-input"
                  @input="setPartPosition(part.id, 'x', $event)"
                />
              </label>
              <label>
                Y
                <input
                  type="number"
                  :value="part.position[1]"
                  step="1"
                  class="coord-input"
                  @input="setPartPosition(part.id, 'y', $event)"
                />
              </label>
              <label>
                Z
                <input
                  type="number"
                  :value="part.position[2]"
                  step="1"
                  class="coord-input"
                  @input="setPartPosition(part.id, 'z', $event)"
                />
              </label>
            </div>
          </li>
        </ul>
      </div>

      <div v-if="isProjectMode" class="history-section">
        <h3>Version History</h3>
        <p class="dim" v-if="versionTargetName">Project: {{ versionTargetName }}</p>
        <p v-if="commitHistory.length === 0" class="dim empty-history">
          No commits yet for this project.
        </p>

        <div v-if="commitHistory.length > 1" class="diff-section">
          <div class="diff-header">
            <h3>Diff Mode</h3>
            <label class="diff-toggle">
              <input
                type="checkbox"
                :checked="isDiffMode"
                :disabled="!canEnableDiff"
                @change="toggleDiffMode"
              />
              Compare Commits
            </label>
          </div>

          <div class="diff-selects">
            <label>
              Base
              <select
                v-model="selectedBaseSha"
                :disabled="!isDiffMode || isLoadingDiff"
              >
                <option
                  v-for="commit in commitHistory"
                  :key="`base-${commit.sha}`"
                  :value="commit.sha"
                >
                  {{ commit.label }}
                </option>
              </select>
            </label>

            <label>
              Head
              <select
                v-model="selectedHeadSha"
                :disabled="!isDiffMode || isLoadingDiff"
              >
                <option
                  v-for="commit in commitHistory"
                  :key="`head-${commit.sha}`"
                  :value="commit.sha"
                >
                  {{ commit.label }}
                </option>
              </select>
            </label>
          </div>

          <div v-if="isDiffMode" class="diff-visualization">
            <div class="diff-mode-buttons" role="group" aria-label="Diff visualization mode">
              <button
                type="button"
                class="diff-mode-btn"
                :class="{ active: diffVisualizationMode === 'overlay' }"
                @click="diffVisualizationMode = 'overlay'"
              >
                Overlay
              </button>
              <button
                type="button"
                class="diff-mode-btn"
                :class="{ active: diffVisualizationMode === 'split' }"
                @click="diffVisualizationMode = 'split'"
              >
                Split
              </button>
            </div>

            <label
              v-if="diffVisualizationMode === 'overlay'"
              class="diff-opacity-control"
            >
              <span>Diff Opacity</span>
              <input
                v-model.number="diffOpacity"
                type="range"
                min="0"
                max="1"
                step="0.01"
              />
              <div class="diff-opacity-labels">
                <span class="base-swatch">Base {{ baseOpacityPercent }}%</span>
                <span class="head-swatch">Head {{ headOpacityPercent }}%</span>
              </div>
            </label>
          </div>

          <p class="dim">Red shows the base commit and green shows the head commit.</p>
          <p v-if="isDiffMode && !canCompareSelectedCommits" class="diff-warning">
            Pick two different commits to render the mesh diff.
          </p>
          <p v-else-if="isLoadingDiff" class="dim">Building diff overlay...</p>
          <p v-else-if="diffError" class="diff-error">{{ diffError }}</p>
          <p v-else-if="isDiffMode && diffResult" class="dim">
            {{ diffFiles.length }} changed file(s),
            {{ diffManifestEntries.length }} manifest delta(s).
          </p>

          <ul v-if="isDiffMode && diffFiles.length > 0" class="diff-file-list">
            <li
              v-for="file in diffFiles"
              :key="`${file.status}-${file.path}`"
              class="diff-file-item"
            >
              <span class="diff-file-status">{{ file.status }}</span>
              <span class="diff-file-path">{{ file.path }}</span>
              <span v-if="file.geometry_changed" class="diff-file-flag">
                geometry
              </span>
            </li>
          </ul>

          <ul
            v-if="isDiffMode && diffManifestEntries.length > 0"
            class="manifest-diff-list"
          >
            <li
              v-for="entry in diffManifestEntries.slice(0, 6)"
              :key="`${entry.change_type}-${entry.path}`"
              class="manifest-diff-item"
            >
              {{ entry.message }}
            </li>
          </ul>
        </div>

        <ul class="commit-list">
          <li
            v-for="commit in commitHistory"
            :key="commit.sha"
            @click="checkoutCommit(commit.sha)"
            class="commit-item"
          >
            <span class="commit-summary">{{ commit.summary }}</span>
            <span class="commit-meta">{{ commit.short_sha }} - {{ commit.author }}</span>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useAssemblyTools } from "../composables/useAssemblyTools";
import { useGitDiff } from "../composables/useGitDiff";
import { useProjectBrowser } from "../composables/useProjectBrowser";
import { useStlImport } from "../composables/useStlImport";
import { useVersioning } from "../composables/useVersioning";
import {
  activeMeshName,
  activeProjectName,
  assembly,
  isProjectMode,
  isWireframe,
  scaleX,
  scaleY,
  scaleZ,
  selectedAssemblyItem,
  selectedItemId,
} from "../store";

type Axis = "x" | "y" | "z";

const {
  filesLoaded,
  isImporting,
  openFiles,
  removePart,
  selectItem,
  toggleItemVisibility,
  totalFilesToLoad,
  updateItemPosition,
} = useStlImport();
const { isLoadingProject, openBrowser } = useProjectBrowser();
const {
  checkoutCommit,
  commitHistory,
  isSavingVersion,
  saveAsNewProject,
  saveVersion,
  suggestedProjectName,
  versionTargetName,
} = useVersioning();
const { debugTargetName, isScaling, prepareWasm, scaleAssembly } =
  useAssemblyTools();
const {
  diffError,
  diffFiles,
  diffManifestEntries,
  diffOpacity,
  diffResult,
  diffVisualizationMode,
  isDiffMode,
  isLoadingDiff,
  loadDiff,
  selectedBaseSha,
  selectedHeadSha,
  setDiffMode,
} = useGitDiff();

const commitMessage = ref("");
const newProjectName = ref("");
const selectedPartName = computed(() => selectedAssemblyItem.value?.name ?? null);
const sessionModeLabel = computed(() => (isProjectMode.value ? "Project Mode" : "File Mode"));
const sessionTitle = computed(
  () => activeProjectName.value?.trim() || "Unsaved Session",
);
const displayedProjectName = computed(() => sessionTitle.value);
const canEnableDiff = computed(() => commitHistory.value.length > 1);
const baseOpacityPercent = computed(() => Math.round((1 - diffOpacity.value) * 100));
const canCompareSelectedCommits = computed(
  () =>
    Boolean(versionTargetName.value) &&
    Boolean(selectedBaseSha.value) &&
    Boolean(selectedHeadSha.value) &&
    selectedBaseSha.value !== selectedHeadSha.value,
);
const headOpacityPercent = computed(() => Math.round(diffOpacity.value * 100));

watch(
  [isProjectMode, suggestedProjectName],
  ([projectMode, suggestedName]) => {
    if (projectMode) {
      return;
    }

    if (!newProjectName.value.trim()) {
      newProjectName.value = suggestedName;
    }
  },
  { immediate: true },
);

watch(
  commitHistory,
  (commits) => {
    if (commits.length === 0) {
      selectedBaseSha.value = null;
      selectedHeadSha.value = null;
      setDiffMode(false);
      return;
    }

    const hasSelectedBase = commits.some((commit) => commit.sha === selectedBaseSha.value);
    const hasSelectedHead = commits.some((commit) => commit.sha === selectedHeadSha.value);

    if (!hasSelectedHead) {
      selectedHeadSha.value = commits[0]?.sha ?? null;
    }

    if (!hasSelectedBase || selectedBaseSha.value === selectedHeadSha.value) {
      selectedBaseSha.value =
        commits.find((commit) => commit.sha !== selectedHeadSha.value)?.sha ?? null;
    }

    if (commits.length < 2) {
      setDiffMode(false);
    }
  },
  { immediate: true },
);

watch(
  [isDiffMode, selectedBaseSha, selectedHeadSha, versionTargetName],
  ([diffModeEnabled, baseSha, headSha, projectName]) => {
    if (!diffModeEnabled || !projectName || !baseSha || !headSha || baseSha === headSha) {
      return;
    }

    void loadDiff(projectName, baseSha, headSha);
  },
);

function setPartVisibility(itemId: string, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }

  toggleItemVisibility(itemId, target.checked);
}

function setPartPosition(itemId: string, axis: Axis, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }

  updateItemPosition(itemId, axis, Number(target.value));
}

function toggleDiffMode(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }

  setDiffMode(target.checked);
}

function handleSaveVersion(): void {
  void saveVersion(commitMessage.value);
}

function handleSaveAsNewProject(): void {
  const projectName = newProjectName.value.trim();
  if (!projectName) {
    return;
  }

  void saveAsNewProject(projectName);
}

function openProjectBrowser(): void {
  void openBrowser();
}
</script>

<style scoped>
.sidebar {
  width: 300px;
  flex-shrink: 0;
  background-color: #1e293b;
  color: #f8fafc;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 15px;
  border-right: 1px solid #334155;
  overflow-y: auto;
}

h2 {
  margin: 0;
  font-size: 1.2rem;
}

h3 {
  font-size: 0.9rem;
  color: #f8fafc;
  margin: 0 0 8px;
}

p {
  color: #94a3b8;
  margin: 0;
}

.dim {
  font-size: 0.8rem;
  color: #64748b;
}

.action-btn {
  background-color: #3b82f6;
  color: white;
  border: none;
  padding: 10px 15px;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 600;
  transition: background-color 0.2s;
}

.action-btn:hover {
  background-color: #2563eb;
}

.action-btn:disabled {
  cursor: wait;
  opacity: 0.7;
}

.primary-actions {
  display: grid;
  gap: 10px;
}

.file-info {
  margin-top: 20px;
  padding-top: 15px;
  border-top: 1px solid #334155;
  display: flex;
  flex-direction: column;
  gap: 15px;
}

.save-btn {
  background-color: #10b981;
}

.save-btn:hover {
  background-color: #059669;
}

.browse-btn {
  background-color: #0ea5e9;
}

.browse-btn:hover {
  background-color: #0284c7;
}

.versioning-section {
  background-color: #0f172a;
  border-radius: 6px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.text-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 0.8rem;
  color: #cbd5e1;
  font-weight: 600;
}

.text-input {
  width: 100%;
  background-color: #1e293b;
  border: 1px solid #334155;
  border-radius: 6px;
  color: #f8fafc;
  padding: 8px 10px;
  font-size: 0.85rem;
}

.text-input:focus {
  outline: none;
  border-color: #3b82f6;
}

.wasm-btn {
  background-color: #f59e0b;
}

.wasm-btn:hover {
  background-color: #d97706;
}

.scale-btn {
  background-color: #8b5cf6;
}

.scale-btn:hover {
  background-color: #7c3aed;
}

.scale-controls {
  background-color: #0f172a;
  border-radius: 6px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.scale-inputs {
  display: flex;
  gap: 8px;
}

.scale-inputs label {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  font-size: 0.8rem;
  color: #94a3b8;
  flex: 1;
}

.scale-inputs input[type="number"] {
  width: 100%;
  background-color: #1e293b;
  border: 1px solid #334155;
  border-radius: 4px;
  color: #f8fafc;
  padding: 6px 4px;
  font-size: 0.85rem;
  text-align: center;
}

.scale-inputs input[type="number"]:focus {
  outline: none;
  border-color: #8b5cf6;
}

.history-section {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.empty-history {
  margin-top: -4px;
}

.diff-section {
  background-color: #0f172a;
  border: 1px solid #1e293b;
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.diff-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.diff-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.8rem;
  color: #cbd5e1;
}

.diff-selects {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}

.diff-visualization {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.diff-mode-buttons {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

.diff-mode-btn {
  border: 1px solid #334155;
  border-radius: 6px;
  background: #1e293b;
  color: #cbd5e1;
  padding: 8px 10px;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;
}

.diff-mode-btn.active {
  background: #1d4ed8;
  border-color: #60a5fa;
  color: #eff6ff;
}

.diff-opacity-control {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.8rem;
  color: #cbd5e1;
}

.diff-opacity-control input[type="range"] {
  width: 100%;
  accent-color: #22c55e;
}

.diff-opacity-labels {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 0.74rem;
}

.base-swatch {
  color: #fca5a5;
}

.head-swatch {
  color: #86efac;
}

.diff-selects label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.8rem;
  color: #94a3b8;
}

.diff-selects select {
  background-color: #1e293b;
  border: 1px solid #334155;
  border-radius: 4px;
  color: #f8fafc;
  padding: 6px 8px;
  font-size: 0.8rem;
}

.diff-selects select:disabled {
  opacity: 0.6;
}

.diff-warning,
.diff-error {
  margin: 0;
  font-size: 0.8rem;
}

.diff-warning {
  color: #fbbf24;
}

.diff-error {
  color: #fca5a5;
}

.diff-file-list,
.manifest-diff-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.diff-file-item,
.manifest-diff-item {
  background-color: rgba(30, 41, 59, 0.75);
  border: 1px solid rgba(71, 85, 105, 0.5);
  border-radius: 6px;
  padding: 8px;
  font-size: 0.78rem;
}

.diff-file-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.diff-file-status {
  text-transform: uppercase;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #93c5fd;
}

.diff-file-path {
  flex: 1;
  color: #e2e8f0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diff-file-flag {
  color: #86efac;
  font-size: 0.7rem;
  text-transform: uppercase;
}

.manifest-diff-item {
  color: #cbd5e1;
}

.commit-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 0.85rem;
  color: #cbd5e1;
}

.commit-item {
  background-color: #0f172a;
  padding: 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.2s;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.commit-item:hover {
  background-color: #1e293b;
}

.commit-summary {
  color: #e2e8f0;
}

.commit-meta {
  color: #94a3b8;
  font-size: 0.75rem;
}

.view-options label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.9rem;
  color: #94a3b8;
  cursor: pointer;
}

.assembly-tree {
  background-color: #0f172a;
  border-radius: 6px;
  padding: 12px;
}

.part-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.part-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  background-color: #1e293b;
  border-radius: 4px;
  border: 1px solid #334155;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    transform 0.15s ease;
}

.part-item.selected {
  border-color: #60a5fa;
  transform: translateX(2px);
}

.part-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.part-name {
  font-size: 0.8rem;
  color: #93c5fd;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.delete-btn {
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.25);
  color: #fecaca;
  cursor: pointer;
  font-size: 0.72rem;
  padding: 4px 6px;
  border-radius: 4px;
  line-height: 1;
  flex-shrink: 0;
}

.delete-btn:hover {
  background-color: rgba(239, 68, 68, 0.25);
}

.visibility-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 0.8rem;
  flex-shrink: 0;
  color: #cbd5e1;
}

.visibility-toggle input[type="checkbox"] {
  cursor: pointer;
  accent-color: #3b82f6;
}

.part-coords {
  display: flex;
  gap: 6px;
}

.part-coords label {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  font-size: 0.75rem;
  color: #94a3b8;
  flex: 1;
}

.coord-input {
  width: 100%;
  background-color: #0f172a;
  border: 1px solid #334155;
  border-radius: 4px;
  color: #f8fafc;
  padding: 4px 3px;
  font-size: 0.8rem;
  text-align: center;
}

.coord-input:focus {
  outline: none;
  border-color: #3b82f6;
}

.progress-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
  background-color: #0f172a;
  padding: 12px;
  border-radius: 6px;
  border: 1px dashed #334155;
  margin-bottom: 15px;
}

progress {
  width: 100%;
  height: 8px;
  border-radius: 4px;
  overflow: hidden;
  border: none;
}

progress::-webkit-progress-bar {
  background-color: #1e293b;
}

progress::-webkit-progress-value {
  background: linear-gradient(90deg, #3b82f6, #60a5fa);
  border-radius: 4px;
  transition: width 0.3s ease;
}

.progress-text {
  font-size: 0.8rem;
  color: #94a3b8;
  text-align: center;
  font-weight: 500;
}
</style>
