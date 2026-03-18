<template>
  <div class="sidebar">
    <h2>Tools</h2>
    <p>STL Viewer</p>
    <button @click="openFile" class="action-btn">Open File.stl</button>

    <div v-if="activeMeshName" class="file-info">
      <div class="view-options">
        <label>
          <input type="checkbox" v-model="isWireframe" />
          Wireframe Mode
        </label>
      </div>
      <p><strong>Current:</strong> {{ activeMeshName }}</p>
      <button @click="saveVersion" class="action-btn save-btn">Save Version</button>
      <button @click="prepareWasm" class="action-btn wasm-btn">Extract Vertices (Wasm Prep)</button>
      <button @click="testWasmScale" class="action-btn scale-btn">Test Wasm Scale</button>

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
import { Mesh, MeshStandardMaterial } from 'three';
import { ref } from 'vue';
import { activeMeshGeometry, activeMeshName, isWireframe } from '../store';
import { extractVertices } from '../math/extractVertices';
import { WasmEngine } from '../math/WasmEngine';

const commitHistory = ref<string[]>([]);

async function openFile() {
  const selected = await open({
    multiple: false,
    filters: [{ name: 'STL Files', extensions: ['stl'] }]
  });

  if (selected && typeof selected === 'string') {
    activeMeshName.value = selected.split(/[\\/]/).pop() || selected;

    // Read binary data
    const fileContents = await readFile(selected);
    const buffer = fileContents.buffer;

    // Parse using STLLoader
    const loader = new STLLoader();
    const geometry = loader.parse(buffer);

    // Center the geometry
    geometry.center();

    // Calculate a reasonable scale
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const maxDim = Math.max(
      box.max.x - box.min.x,
      box.max.y - box.min.y,
      box.max.z - box.min.z
    );

    // Target size of about 5 units
    const scale = 5 / maxDim;
    geometry.scale(scale, scale, scale);

    activeMeshGeometry.value = geometry;

    // Attempt to load history if available
    const appDataDirPath = await appDataDir();
    const cleanProjectName = activeMeshName.value.replace(/\.stl$/i, '');
    const saveDir = await join(appDataDirPath, 'STL_Viewer_Projects', cleanProjectName);
    await fetchHistory(saveDir);
  }
}

async function saveVersion() {
  if (!activeMeshGeometry.value || !activeMeshName.value) return;

  try {
    // 1. Export STL
    const exporter = new STLExporter();
    const mesh = new Mesh(activeMeshGeometry.value as any, new MeshStandardMaterial());
    const stlString = exporter.parse(mesh);

    // 2. Prepare Git directory
    const appDataDirPath = await appDataDir();
    const cleanProjectName = activeMeshName.value.replace(/\.stl$/i, '');
    const saveDir = await join(appDataDirPath, 'STL_Viewer_Projects', cleanProjectName);

    const dirExists = await exists(saveDir);
    if (!dirExists) {
      await mkdir(saveDir, { recursive: true });
    }

    const filePath = await join(saveDir, activeMeshName.value);
    await writeTextFile(filePath, stlString);

    // 3. Git Init & Commit
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

    // 4. Update History
    await fetchHistory(saveDir);
  } catch (error) {
    console.error('Save Version Error:', error);
  }
}

async function fetchHistory(saveDir: string) {
  try {
    const dirExists = await exists(saveDir);
    if (!dirExists) {
      commitHistory.value = [];
      return;
    }

    // Check if it's a git repo to prevent fatal: not a git repository errors
    const gitDirExists = await exists(await join(saveDir, '.git'));
    if (!gitDirExists) {
      commitHistory.value = [];
      return;
    }

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

function prepareWasm() {
  if (!activeMeshGeometry.value) return;

  try {
    const vertices = extractVertices(activeMeshGeometry.value as any);
    console.log(`Extracted ${vertices.length} vertices (${vertices.length / 3} points) for future Wasm ops.`);
    alert(`Prepared ${vertices.length} Float32 entries for WebAssembly! Check console.`);
  } catch (e) {
    console.error('Wasm Preparation Error:', e);
  }
}

async function testWasmScale() {
  const geo = activeMeshGeometry.value as any;
  if (!geo) return;

  try {
    // 1. Grab the raw position Float32Array from the TresJS/Three.js geometry.
    const posAttr = geo.attributes?.position;
    if (!posAttr) {
      alert('No position attribute found on the current mesh geometry.');
      return;
    }
    const vertices: Float32Array = posAttr.array as Float32Array;

    // 2. Load the Wasm engine (cached after first load via the injected <script> tag).
    const engine = await WasmEngine.create();

    // 3. Scale every Y coordinate by 1.5 using the C++ function.
    const scaled = engine.scaleVerticesY(vertices, 1.5);

    // 4. Write the result back into the buffer-backed attribute array.
    posAttr.array.set(scaled);

    // 5. Signal Three.js / TresJS to re-upload the buffer to the GPU.
    posAttr.needsUpdate = true;

    // Recompute normals so lighting stays correct after the deformation.
    geo.computeVertexNormals();

    console.log('[WasmEngine] Y-scale applied. First 6 values:', Array.from(scaled.slice(0, 6)));
  } catch (err) {
    console.error('[WasmEngine] testWasmScale failed:', err);
    alert('Wasm scale failed — check the console for details.');
  }
}

async function checkoutCommit(commitStr: string) {
  if (!activeMeshName.value) return;
  const hash = commitStr.split(' ')[0];
  if (!hash) return;

  try {
    const appDataDirPath = await appDataDir();
    const cleanProjectName = activeMeshName.value.replace(/\.stl$/i, '');
    const saveDir = await join(appDataDirPath, 'STL_Viewer_Projects', cleanProjectName);

    // Git checkout
    const checkoutCmd = Command.create('git', ['checkout', hash, '--', activeMeshName.value], { cwd: saveDir });
    const output = await checkoutCmd.execute();

    if (output.code !== 0) {
      console.error('Git checkout failed:', output.stderr);
      alert('Failed to checkout commit: ' + output.stderr);
      return;
    }

    // Re-read file from saveDir
    const filePath = await join(saveDir, activeMeshName.value);
    const fileContents = await readFile(filePath);
    const buffer = fileContents.buffer;

    // Parse and update geometry
    const loader = new STLLoader();
    const geometry = loader.parse(buffer);
    geometry.center();
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const maxDim = Math.max(
      box.max.x - box.min.x,
      box.max.y - box.min.y,
      box.max.z - box.min.z
    );
    const scale = 5 / maxDim;
    geometry.scale(scale, scale, scale);

    activeMeshGeometry.value = geometry;
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
}

h2 {
  margin: 0;
  font-size: 1.2rem;
}

p {
  color: #94a3b8;
  margin: 0;
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

.history-section {
  margin-top: 10px;
}

.history-section h3 {
  font-size: 0.9rem;
  color: #f8fafc;
  margin-bottom: 10px;
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
</style>
