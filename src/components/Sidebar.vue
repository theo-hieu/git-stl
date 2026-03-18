<template>
  <div class="sidebar">
    <h2>Tools</h2>
    <p>STL Viewer</p>
    <button @click="openFile" class="action-btn" :disabled="isImporting">
      {{ isImporting ? 'Importing…' : 'Import Assembly (Multi-Select)' }}
    </button>

    <!-- Batch Progress Tracker -->
    <div v-if="isImporting" class="progress-container">
      <progress :max="totalFilesToLoad" :value="filesLoaded"></progress>
      <span class="progress-text">{{ filesLoaded }} / {{ totalFilesToLoad }} Parts Loaded</span>
    </div>

    <div v-if="assembly.length > 0" class="file-info">
      <!-- View options -->
      <div class="view-options">
        <label>
          <input type="checkbox" v-model="isWireframe" />
          Wireframe Mode
        </label>
      </div>

      <!-- Assembly summary -->
      <p>
        <strong>{{ assembly.length }} mesh(es) loaded</strong><br />
        <span class="dim">Last: {{ activeMeshName }}</span>
      </p>

      <!-- Git versioning (operates on last-opened file) -->
      <button @click="saveVersion" class="action-btn save-btn">Save Version</button>
      <button @click="prepareWasm" class="action-btn wasm-btn">Extract Vertices (Wasm Prep)</button>

      <!-- ── XYZ Scale Controls ───────────────────────────── -->
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
        <button @click="scaleAssembly" class="action-btn scale-btn">Scale Assembly</button>
      </div>

      <!-- ── Assembly Tree ────────────────────────────────────────── -->
      <div class="assembly-tree">
        <h3>Assembly Tree</h3>
        <ul class="part-list">
          <li v-for="(part, idx) in assembly" :key="idx" class="part-item">
            <div class="part-header">
              <label class="visibility-toggle" :title="part.visible ? 'Hide part' : 'Show part'">
                <input type="checkbox" v-model="part.visible" />
                👁
              </label>
              <span class="part-name">{{ part.name }}</span>
              <button class="delete-btn" title="Remove part" @click="removePart(idx)">❌</button>
            </div>
            <div class="part-coords">
              <label>
                X
                <input type="number" :value="part.position[0]"
                  @input="part.position[0] = +($event.target as HTMLInputElement).value" step="1" class="coord-input" />
              </label>
              <label>
                Y
                <input type="number" :value="part.position[1]"
                  @input="part.position[1] = +($event.target as HTMLInputElement).value" step="1" class="coord-input" />
              </label>
              <label>
                Z
                <input type="number" :value="part.position[2]"
                  @input="part.position[2] = +($event.target as HTMLInputElement).value" step="1" class="coord-input" />
              </label>
            </div>
          </li>
        </ul>
      </div>

      <!-- Git history -->
      <div v-if="commitHistory.length > 0" class="history-section">
        <h3>Version History</h3>
        <ul class="commit-list">
          <li v-for="(commit, idx) in commitHistory" :key="idx" @click="checkoutCommit(commit)" class="commit-item">{{
            commit }}</li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { open } from '@tauri-apps/plugin-dialog';
import { readFile, writeTextFile, mkdir, exists } from '@tauri-apps/plugin-fs';
import { Command } from '@tauri-apps/plugin-shell';
import { appDataDir, join } from '@tauri-apps/api/path';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { BufferGeometry, BufferAttribute, Mesh, MeshStandardMaterial, Box3, Vector3 } from 'three';
import { ref, computed } from 'vue';
import { assembly, activeMeshName, isWireframe, scaleX, scaleY, scaleZ, cameraPosition, controlsTarget } from '../store';
import { extractVertices } from '../math/extractVertices';
import { WasmEngine } from '../math/WasmEngine';

/** Batch tracking for multi-file imports */
const fileQueue = ref<string[]>([]);
const activeWorkers = ref(0);
const MAX_WORKERS = navigator.hardwareConcurrency ? Math.max(1, navigator.hardwareConcurrency - 1) : 3;

const totalFilesToLoad = ref(0);
const filesLoaded = ref(0);

/** True while STL files are being parsed in the worker — computed from counts. */
const isImporting = computed(() => totalFilesToLoad.value > 0 && filesLoaded.value < totalFilesToLoad.value);

const commitHistory = ref<string[]>([]);

// ── Import Assembly — multi-select, appends every chosen STL ─────────────────

async function openFile() {
  const selected = await open({
    multiple: true,
    filters: [{ name: 'STL Files', extensions: ['stl'] }]
  });

  if (!selected) return;

  const paths: string[] = Array.isArray(selected) ? selected : [selected];
  if (paths.length === 0) return;

  // Reset trackers and populate queue
  totalFilesToLoad.value = paths.length;
  filesLoaded.value = 0;
  fileQueue.value = [...paths];

  // Start the engine
  processNextInQueue();
}

/**
 * Concurrency Queue Logic:
 * Spawns up to MAX_WORKERS simultaneously. Re-calls itself when a slot opens.
 */
async function processNextInQueue() {
  while (activeWorkers.value < MAX_WORKERS && fileQueue.value.length > 0) {
    activeWorkers.value++;
    const filePath = fileQueue.value.shift()!;
    const name = filePath.split(/[\\/]/).pop() || filePath;

    // Read file via Tauri FS
    try {
      const fileContents = await readFile(filePath);
      const buffer = fileContents.buffer;

      // Spawn a dedicated worker for this file
      const worker = new Worker(
        new URL('../workers/stlWorker.ts', import.meta.url),
        { type: 'module' }
      );

      worker.onmessage = (event) => {
        const { positions, normals, error } = event.data as {
          positions?: Float32Array;
          normals?: Float32Array;
          error?: string;
        };

        if (error) {
          console.error(`Worker error for ${name}:`, error);
        } else if (positions) {
          // Success: Push parsed geometry to assembly
          const geo = new BufferGeometry();
          geo.setAttribute('position', new BufferAttribute(positions, 3));

          if (normals && normals.length === positions.length) {
            geo.setAttribute('normal', new BufferAttribute(normals, 3));
          } else {
            geo.computeVertexNormals();
          }

          geo.computeBoundingBox();
          geo.computeBoundingSphere();

          assembly.value.push({
            name,
            geometry: geo,
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            visible: true
          });
          activeMeshName.value = name;
        } else {
          console.error(`Worker returned no geometry for ${name}.`);
        }

        // Cleanup and iterate
        worker.terminate();
        filesLoaded.value++;
        activeWorkers.value--;

        if (filesLoaded.value === totalFilesToLoad.value) {
          frameAssembly();
        }
        processNextInQueue();
      };

      worker.onerror = (err) => {
        console.error(`Worker crash for ${name}:`, err.message);
        worker.terminate();
        filesLoaded.value++;
        activeWorkers.value--;

        if (filesLoaded.value === totalFilesToLoad.value) {
          frameAssembly();
        }
        processNextInQueue();
      };

      // Send buffer to worker
      worker.postMessage({ id: 0, buffer }, [buffer]);

    } catch (err) {
      console.error(`FS Read error for ${name}:`, err);
      filesLoaded.value++;
      activeWorkers.value--;

      if (filesLoaded.value === totalFilesToLoad.value) {
        frameAssembly();
      }
      processNextInQueue();
    }
  }
}

/** Fits the camera to the complete set of loaded parts */
function frameAssembly() {
  if (assembly.value.length === 0) return;
  const masterBox = new Box3();
  for (const item of assembly.value) {
    item.geometry.computeBoundingBox();
    if (item.geometry.boundingBox) {
      masterBox.union(item.geometry.boundingBox);
    }
  }

  const center = new Vector3();
  masterBox.getCenter(center);
  const size = new Vector3();
  masterBox.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);

  controlsTarget.value = [center.x, center.y, center.z];
  cameraPosition.value = [
    center.x + maxDim * 1.5,
    center.y + maxDim * 1.5,
    center.z + maxDim * 1.5,
  ];

  // Optionally jump history to the last opened file
  if (activeMeshName.value) {
    jumpToHistory(activeMeshName.value);
  }
}

async function jumpToHistory(fileName: string) {
  const appDataDirPath = await appDataDir();
  const cleanProjectName = fileName.replace(/\.stl$/i, '');
  const saveDir = await join(appDataDirPath, 'STL_Viewer_Projects', cleanProjectName);
  await fetchHistory(saveDir);
}

// ── Scale Assembly via Wasm ───────────────────────────────────────────────────

async function scaleAssembly() {
  if (assembly.value.length === 0) return;

  try {
    const engine = await WasmEngine.create();

    for (const item of assembly.value) {
      const geo = item.geometry as any;
      const posAttr = geo.attributes?.position;
      if (!posAttr) continue;

      const vertices: Float32Array = posAttr.array as Float32Array;

      // Call the new three-parameter C++ function
      const scaled = engine.scaleVertices(
        vertices,
        scaleX.value,
        scaleY.value,
        scaleZ.value,
      );

      // Write back and flag for GPU re-upload
      posAttr.array.set(scaled);
      posAttr.needsUpdate = true;

      geo.computeVertexNormals();
    }

    console.log(
      `[WasmEngine] XYZ-scale applied to ${assembly.value.length} mesh(es):`,
      `X=${scaleX.value}  Y=${scaleY.value}  Z=${scaleZ.value}`,
    );
  } catch (err) {
    console.error('[WasmEngine] scaleAssembly failed:', err);
    alert('Wasm scale failed — check the console for details.');
  }
}

// ── Save Version (operates on activeMeshName / last-opened part) ─────────────

async function saveVersion() {
  if (!activeMeshName.value) return;

  // Find the geometry for the active mesh name
  const activeItem = assembly.value.find(i => i.name === activeMeshName.value);
  if (!activeItem) return;

  try {
    const exporter = new STLExporter();
    const mesh = new Mesh(activeItem.geometry as any, new MeshStandardMaterial());
    const stlString = exporter.parse(mesh);

    const appDataDirPath = await appDataDir();
    const cleanProjectName = activeMeshName.value.replace(/\.stl$/i, '');
    const saveDir = await join(appDataDirPath, 'STL_Viewer_Projects', cleanProjectName);

    const dirExists = await exists(saveDir);
    if (!dirExists) {
      await mkdir(saveDir, { recursive: true });
    }

    const filePath = await join(saveDir, activeMeshName.value);
    await writeTextFile(filePath, stlString);

    const initCmd = Command.create('git', ['init'], { cwd: saveDir });
    await initCmd.execute();
    const configNameCmd = Command.create('git', ['config', 'user.name', 'STL Viewer App'], { cwd: saveDir });
    await configNameCmd.execute();
    const configEmailCmd = Command.create('git', ['config', 'user.email', 'stl@viewer.local'], { cwd: saveDir });
    await configEmailCmd.execute();
    const addCmd = Command.create('git', ['add', '.'], { cwd: saveDir });
    await addCmd.execute();
    const commitCmd = Command.create('git', ['commit', '-m', `Version saved at ${new Date().toLocaleString()}`], { cwd: saveDir });
    await commitCmd.execute();

    await fetchHistory(saveDir);
  } catch (error) {
    console.error('Save Version Error:', error);
  }
}

// ── Fetch Git History ─────────────────────────────────────────────────────────

async function fetchHistory(saveDir: string) {
  try {
    const dirExists = await exists(saveDir);
    if (!dirExists) { commitHistory.value = []; return; }

    const gitDirExists = await exists(await join(saveDir, '.git'));
    if (!gitDirExists) { commitHistory.value = []; return; }

    const logCmd = Command.create('git', ['log', '--pretty=format:%h - %an, %ar : %s'], { cwd: saveDir });
    const output = await logCmd.execute();
    if (output.code === 0) {
      commitHistory.value = output.stdout.split('\n').filter(Boolean);
    }
  } catch (error) {
    console.error('Fetch History Error:', error);
    commitHistory.value = [];
  }
}

// ── Remove a single part from the assembly ───────────────────────────────────

function removePart(index: number) {
  const part = assembly.value[index];
  if (!part) return;

  // Free GPU / WebGL memory before dropping the reference
  part.geometry.dispose();
  // If a dedicated material object ever lives on the item, dispose it too:
  // (part as any).material?.dispose?.();

  assembly.value.splice(index, 1);
}

// ── Wasm Prep (debug) ─────────────────────────────────────────────────────────

function prepareWasm() {
  if (assembly.value.length === 0) return;
  try {
    // Extract from the first mesh for diagnostics
    const vertices = extractVertices(assembly.value[0].geometry as any);
    console.log(`Extracted ${vertices.length} vertices (${vertices.length / 3} points) for future Wasm ops.`);
    alert(`Prepared ${vertices.length} Float32 entries for WebAssembly! Check console.`);
  } catch (e) {
    console.error('Wasm Preparation Error:', e);
  }
}

// ── Git Checkout ──────────────────────────────────────────────────────────────

async function checkoutCommit(commitStr: string) {
  if (!activeMeshName.value) return;
  const hash = commitStr.split(' ')[0];
  if (!hash) return;

  try {
    const appDataDirPath = await appDataDir();
    const cleanProjectName = activeMeshName.value.replace(/\.stl$/i, '');
    const saveDir = await join(appDataDirPath, 'STL_Viewer_Projects', cleanProjectName);

    const checkoutCmd = Command.create('git', ['checkout', hash, '--', activeMeshName.value], { cwd: saveDir });
    const output = await checkoutCmd.execute();

    if (output.code !== 0) {
      console.error('Git checkout failed:', output.stderr);
      alert('Failed to checkout commit: ' + output.stderr);
      return;
    }

    const filePath = await join(saveDir, activeMeshName.value);
    const fileContents = await readFile(filePath);
    const buffer = fileContents.buffer;

    const loader = new STLLoader();
    const geometry = loader.parse(buffer);

    // Raw CAD vertices are intentionally left unmodified — no centering, no auto-scale.
    // Replace the matching part in the assembly (or append if not found)
    const idx = assembly.value.findIndex(i => i.name === activeMeshName.value);
    if (idx !== -1) {
      // Preserve the existing position/rotation when restoring a git version
      const prev = assembly.value[idx];
      assembly.value[idx] = { name: activeMeshName.value, geometry, position: prev.position, rotation: prev.rotation, visible: prev.visible };
    } else {
      assembly.value.push({ name: activeMeshName.value!, geometry, position: [0, 0, 0], rotation: [0, 0, 0], visible: true });
    }
  } catch (error) {
    console.error('Checkout Commit Error:', error);
  }
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

/* ── XYZ scale panel ── */
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

/* ── History ── */
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

/* ── Assembly Tree ── */
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
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.75rem;
  padding: 2px 4px;
  border-radius: 3px;
  line-height: 1;
  flex-shrink: 0;
  opacity: 0.7;
  transition: opacity 0.15s;
}

.delete-btn:hover {
  opacity: 1;
  background-color: rgba(239, 68, 68, 0.2);
}

.visibility-toggle {
  display: flex;
  align-items: center;
  gap: 3px;
  cursor: pointer;
  font-size: 0.9rem;
  flex-shrink: 0;
  opacity: 0.8;
  transition: opacity 0.15s;
}

.visibility-toggle:hover {
  opacity: 1;
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

/* ── Batch Progress UI ── */
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
