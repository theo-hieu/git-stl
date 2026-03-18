<template>
  <div class="sidebar">
    <h2>Tools</h2>
    <p>STL Viewer</p>

    <button @click="openFiles" class="action-btn" :disabled="isImporting">
      {{ isImporting ? "Importing..." : "Import Assembly (Multi-Select)" }}
    </button>

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
        <span class="dim">Project: {{ activeProjectName ?? "None" }}</span><br />
        <span class="dim">Last Imported: {{ activeMeshName ?? "None" }}</span><br />
        <span class="dim">Selected Part: {{ selectedPartName ?? "None" }}</span>
      </p>

      <button
        @click="saveVersion"
        class="action-btn save-btn"
        :disabled="!versionTargetName"
      >
        Save Project Version
      </button>
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

      <div v-if="commitHistory.length > 0" class="history-section">
        <h3>Version History</h3>
        <p class="dim" v-if="versionTargetName">Project: {{ versionTargetName }}</p>
        <ul class="commit-list">
          <li
            v-for="commit in commitHistory"
            :key="commit"
            @click="checkoutCommit(commit)"
            class="commit-item"
          >
            {{ commit }}
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useAssemblyTools } from "../composables/useAssemblyTools";
import { useStlImport } from "../composables/useStlImport";
import { useVersioning } from "../composables/useVersioning";
import {
  activeMeshName,
  activeProjectName,
  assembly,
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
const { checkoutCommit, commitHistory, saveVersion, versionTargetName } =
  useVersioning();
const { debugTargetName, isScaling, prepareWasm, scaleAssembly } =
  useAssemblyTools();

const selectedPartName = computed(() => selectedAssemblyItem.value?.name ?? null);

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
}

.commit-item:hover {
  background-color: #1e293b;
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
