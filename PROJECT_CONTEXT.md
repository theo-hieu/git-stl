# Project Context

## Project Overview

This project is a desktop STL assembly viewer built with Vue, Three.js, and Tauri. Its main purpose is to let a user import one or more STL files, inspect them together as a simple assembly, adjust visibility and placement, apply geometry scaling, and save versioned snapshots of an active part using Git-backed history stored in the app data directory.

The product value is in combining a lightweight desktop UI with local-native file access, fast WebAssembly-based STL parsing, and simple revision tracking for mesh edits without requiring a remote backend.

## Tech Stack & Architecture

- Frontend: Vue 3 with `<script setup>` single-file components and TypeScript.
- Rendering: Three.js via TresJS (`@tresjs/core` and `@tresjs/cientos`) for the 3D scene, camera, lights, and controls.
- Desktop shell: Tauri 2, with plugins for dialog, filesystem access, opener, and shell execution.
- Geometry processing: Two C++ modules compiled with Emscripten/WebAssembly.
- Build tooling: Vite 6, `vue-tsc`, TypeScript bundler-mode config, PowerShell and Bash helper scripts for Wasm compilation.

Architecturally, the app is a small component-based desktop client with a few clear subsystems:

- UI shell: `App.vue` composes the sidebar and scene.
- Shared reactive state: `src/store.ts` exposes app-wide Vue refs instead of using Pinia/Vuex.
- Import pipeline: Tauri reads STL bytes, a Web Worker parses them through Wasm, and the UI converts the result into Three.js `BufferGeometry`.
- Rendering pipeline: the scene reacts directly to the shared assembly state.
- Persistence/versioning pipeline: the active mesh is exported to STL, written under Tauri app data, and versioned with local Git commands.

The Rust/Tauri layer currently acts mostly as a plugin host and application container. Almost all domain logic lives in the frontend TypeScript layer.

## Core Capabilities & Features

- Open multiple STL files at once through a native file dialog.
- Parse STL data off the main thread using a dedicated worker and a Wasm STL parser.
- Display all loaded parts together in a Three.js/TresJS 3D scene.
- Show a placeholder animated box when no geometry is loaded.
- Toggle wireframe rendering for the full assembly.
- Toggle per-part visibility.
- Adjust per-part XYZ position values from the sidebar.
- Remove individual parts from the assembly and dispose of their geometry.
- Automatically frame the camera around the loaded assembly after import completes.
- Apply assembly-wide XYZ scaling using a separate Wasm geometry module.
- Extract raw vertex data from geometry for future Wasm/debug workflows.
- Export the currently active mesh as STL.
- Save versions of the active mesh into an app-data project folder backed by Git commits.
- Read Git history for the active mesh and restore a saved revision into the scene.

Important current constraints:

- The custom worker parser is built for binary STL parsing; there is no custom ASCII STL path in the worker.
- Version history is centered on the most recently opened mesh (`activeMeshName`), not the full assembly as a unit.
- The scaling path depends on `public/geometry.js` and `public/geometry.wasm`; those artifacts are produced by the Wasm build scripts and do not appear in the current tracked file list.
- Native Rust commands are minimal; the included `greet` command is template scaffolding and is not part of the main workflow.

## Key File Structure & Modules

### Root

- `package.json`: frontend and Tauri dependencies plus `dev`, `build`, `preview`, and `tauri` scripts.
- `vite.config.ts`: Vue plugin setup and Tauri-specific dev-server behavior.
- `build-wasm.ps1`, `build-wasm.sh`: compile C++ sources into browser-loadable Wasm assets in `public/`.
- `index.html`: Vite entry page.
- `README.md`: still mostly template content rather than project-specific documentation.

### Frontend App

- `src/main.ts`: bootstraps Vue and registers TresJS.
- `src/App.vue`: top-level layout with a fixed sidebar and a scene panel.
- `src/style.css`: global page sizing and background styling.
- `src/store.ts`: shared reactive application state.

### UI Components

- `src/components/Sidebar.vue`: primary control surface. Handles import, queue orchestration, version save/history, assembly transform controls, removal, and debug/Wasm actions.
- `src/components/Scene.vue`: renders camera, controls, lights, and one mesh per loaded assembly item.
- `src/components/AnimatedBox.vue`: empty-state visual shown when no STL data is loaded.

### Geometry / Wasm

- `src/math/extractVertices.ts`: converts a `BufferGeometry` position attribute into a flat `Float32Array`.
- `src/math/WasmEngine.ts`: browser-side loader/wrapper for the geometry Wasm module that scales vertex arrays.
- `src/math/geometry.cpp`: C++ in-place vertex scaling functions compiled to `geometry.js`/`geometry.wasm`.
- `src/math/stl_parser.cpp`: C++ binary STL parser compiled to `stl_parser.wasm`.

### Worker Pipeline

- `src/workers/stlWorker.ts`: dedicated worker that lazily initializes the STL parser Wasm module and parses STL bytes off the UI thread.
- `src/workers/stlParserModule.ts`: low-level Wasm instantiation wrapper for `stl_parser.wasm`, including memory access helpers.

### Static/Public Assets

- `public/stl_parser.wasm`: checked-in parser Wasm artifact used by the worker.
- `public/geometry.js`, `public/geometry.wasm`: expected runtime assets for assembly scaling, generated by the Wasm build scripts.

### Tauri Shell

- `src-tauri/src/main.rs`: native entry point.
- `src-tauri/src/lib.rs`: Tauri builder, plugin registration, and template `greet` command.
- `src-tauri/tauri.conf.json`: app metadata, build hooks, bundle settings, and window configuration.
- `src-tauri/capabilities/default.json`: permissions, including app-data filesystem access and `git` execution through the shell plugin.
- `src-tauri/Cargo.toml`: Rust dependencies and plugin declarations.

## Data Flow & State Management

The app uses module-level Vue refs in `src/store.ts` as its shared state layer. There is no dedicated store framework, reducer pattern, or backend persistence model for in-memory state.

Primary state objects:

- `assembly`: array of loaded parts, each containing display name, `BufferGeometry`, position, rotation, and visibility.
- `activeMeshName`: filename of the most recently opened mesh, used as the target for version save/history actions.
- `isWireframe`: global display toggle.
- `scaleX`, `scaleY`, `scaleZ`: global scale factors for Wasm-based scaling.
- `cameraPosition`, `controlsTarget`: camera framing state used by the scene.

### Import Flow

1. The user selects one or more `.stl` files in `Sidebar.vue`.
2. Tauri's filesystem plugin reads each file into memory.
3. A queue in `Sidebar.vue` dispatches work up to a concurrency limit based on `navigator.hardwareConcurrency`.
4. Each file is sent to `src/workers/stlWorker.ts`.
5. The worker loads `stl_parser.wasm` through `stlParserModule.ts`.
6. The Wasm parser returns flat vertex positions.
7. The UI wraps that data in a Three.js `BufferGeometry`, computes normals and bounds, and appends an `AssemblyItem` to `assembly`.
8. After all files finish, the app frames the camera to the combined bounding box.

### Render Flow

- `Scene.vue` observes the shared refs directly.
- Each `assembly` item becomes a `TresMesh`.
- Global render flags like wireframe and camera target are read reactively from the store.

### Geometry Transformation Flow

1. The user changes `scaleX/Y/Z` in the sidebar.
2. `Sidebar.vue` creates a `WasmEngine`.
3. `WasmEngine` loads `geometry.js`, which then loads the matching Wasm binary.
4. Each mesh position buffer is copied into Wasm memory, scaled in C++, copied back, and written into the existing Three.js attribute array.
5. The geometry is marked dirty and normals are recomputed.

This is an in-memory mutation path; the transformed mesh is not automatically persisted unless the user saves a version afterward.

### Versioning / Persistence Flow

1. The active mesh is exported back to STL using `STLExporter`.
2. The file is written to `appDataDir()/STL_Viewer_Projects/<mesh-name-without-extension>/`.
3. The app initializes a Git repository there if needed, configures a local identity, stages the file, and creates a commit.
4. The Git log is read back through the Tauri shell plugin and shown in the sidebar.
5. On checkout, the selected historical STL is restored from Git, read from disk, parsed with Three.js `STLLoader`, and swapped into the matching `assembly` item.

State persistence is therefore split into two layers:

- Session state: Vue refs in memory only.
- Saved mesh history: STL files plus Git metadata under the Tauri app-data directory.

## Extension Points

- `src/store.ts`: best place to add new shared view settings, selection state, metadata, or per-part editing data.
- `src/components/Sidebar.vue`: current home for most user workflows. New import/export actions, transform tools, mesh metadata panels, and history controls would likely start here.
- `src/components/Scene.vue`: natural place for selection, gizmos, clipping, measurement tools, camera presets, or richer materials.
- `src/workers/stlWorker.ts` and `src/workers/stlParserModule.ts`: extension seam for more parsing features, progress reporting, cancellation, ASCII STL support, or richer geometry metadata extraction.
- `src/math/geometry.cpp` and `src/math/WasmEngine.ts`: intended expansion point for more performance-sensitive mesh operations such as translation, rotation, welding, simplification, bounding metrics, or analysis kernels.
- `src-tauri/src/lib.rs`: best place to add native commands if future features need stronger filesystem orchestration, packaged Git integration, background jobs, or OS-native capabilities.
- `src-tauri/capabilities/default.json`: must evolve alongside any new Tauri plugin usage or native command surface.

## Practical Notes For Future Work

- The current codebase concentrates a large amount of domain logic inside `Sidebar.vue`. If features grow, import/versioning/transform logic would benefit from extraction into composables or service modules.
- The current shared state model is simple and easy to follow, but it has no undo/redo, no persisted workspace state, and no explicit selected-part concept.
- The project already has a strong path for adding more Wasm-powered geometry operations, and that appears to be a deliberate architectural direction.
- Because Git execution is permissioned through Tauri shell capabilities, versioning features are tightly coupled to desktop packaging and app-data filesystem access rather than a pure web deployment model.
