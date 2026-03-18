# Project Context

## Project Overview

This project is a desktop STL assembly viewer built with Vue, Three.js, and Tauri. Its main purpose is to let a user import one or more STL files, inspect them together as a simple assembly, adjust visibility and placement, apply geometry scaling, and save versioned snapshots of an active part using Git-backed history stored in the app data directory.

The product value is in combining a lightweight desktop UI with local-native file access, fast WebAssembly-based STL parsing, worker-generated BVH acceleration for high-poly meshes, and simple revision tracking for mesh edits without requiring a remote backend.

## Tech Stack & Architecture

- Frontend: Vue 3 with `<script setup>` single-file components and TypeScript.
- Rendering: Three.js via TresJS (`@tresjs/core` and `@tresjs/cientos`) for the 3D scene, camera, lights, and controls.
- Spatial acceleration: `three-mesh-bvh` for accelerated mesh raycasting against imported STL geometry.
- Desktop shell: Tauri 2, with plugins for dialog, filesystem access, opener, and shell execution.
- Geometry processing: Two C++ modules compiled with Emscripten/WebAssembly.
- Build tooling: Vite 6, `vue-tsc`, TypeScript bundler-mode config, PowerShell and Bash helper scripts for Wasm compilation.

Architecturally, the app is a small component-based desktop client with a few clear subsystems:

- UI shell: `App.vue` composes the sidebar and scene.
- Shared reactive state: `src/store.ts` exposes app-wide Vue refs instead of using Pinia/Vuex.
- Import pipeline: `useStlImport.ts` reads STL bytes through Tauri, coordinates a worker queue, reconstructs raw Three.js `BufferGeometry` instances, and attaches worker-generated BVH data for fast raycasting.
- Rendering pipeline: the scene reacts directly to the shared assembly state while keeping heavyweight Three.js objects out of Vue's deep proxy system via `markRaw()`.
- Persistence/versioning pipeline: the full assembly is exported as per-part STL files plus a manifest under Tauri app data and versioned with local Git commands.

The Rust/Tauri layer currently acts mostly as a plugin host and application container. Almost all domain logic lives in the frontend TypeScript layer.

## Core Capabilities & Features

- Open multiple STL files at once through a native file dialog.
- Parse STL data off the main thread using a dedicated worker and a Wasm STL parser.
- Generate serialized `three-mesh-bvh` acceleration structures off the main thread during STL import.
- Display all loaded parts together in a Three.js/TresJS 3D scene.
- Show a placeholder animated box when no geometry is loaded.
- Toggle wireframe rendering for the full assembly.
- Toggle per-part visibility.
- Adjust per-part XYZ position values from the sidebar.
- Remove individual parts from the assembly and explicitly dispose of their geometry and material.
- Automatically frame the camera around the loaded assembly after import completes.
- Apply assembly-wide XYZ scaling using a separate Wasm geometry module.
- Extract raw vertex data from geometry for future Wasm/debug workflows.
- Save versions of the current assembly into an app-data project folder backed by Git commits.
- Read Git history for the current project and restore a saved revision into the scene.

Important current constraints:

- The custom worker parser is built for binary STL parsing; there is no custom ASCII STL path in the worker.
- Three.js `BufferGeometry` and `MeshStandardMaterial` instances stored alongside assembly items must stay raw and must be explicitly disposed when removed or replaced.
- Imported STL geometries arrive with a worker-generated serialized BVH that is deserialized on the main thread and assigned to `geometry.boundsTree`; disposal must also clear the BVH via `disposeBoundsTree()`.
- The scaling path depends on `public/geometry.wasm`; that artifact is produced by the Wasm build scripts and does not appear in the current tracked file list.
- Native Rust commands are minimal; the included `greet` command is template scaffolding and is not part of the main workflow.

## Key File Structure & Modules

### Root

- `package.json`: frontend and Tauri dependencies plus `dev`, `build`, `preview`, and `tauri` scripts.
- `vite.config.ts`: Vue plugin setup and Tauri-specific dev-server behavior.
- `build-wasm.ps1`, `build-wasm.sh`: compile C++ sources into browser-loadable Wasm assets in `public/`.
- `index.html`: Vite entry page.
- `README.md`: still mostly template content rather than project-specific documentation.

### Frontend App

- `src/main.ts`: bootstraps Vue, registers TresJS, and loads the shared Three/BVH prototype patch module.
- `src/App.vue`: top-level layout with a fixed sidebar and a scene panel.
- `src/setupThreeMeshBvh.ts`: patches Three.js prototypes so meshes use `acceleratedRaycast` and geometries expose `computeBoundsTree` / `disposeBoundsTree`.
- `src/style.css`: global page sizing and background styling.
- `src/store.ts`: shared reactive application state plus the `AssemblyItem` factory that raw-wraps Three.js payloads before they enter Vue state.

### UI Components

- `src/components/Sidebar.vue`: primary control surface. Handles import triggers, version save/history, assembly transform controls, removal, and debug/Wasm actions.
- `src/components/Scene.vue`: renders camera, controls, lights, and one mesh per loaded assembly item, binding each part's raw material directly. Current interaction is selection-on-click only; there are no per-mesh pointer-move or pointer-over handlers in the scene template.
- `src/components/AnimatedBox.vue`: empty-state visual shown when no STL data is loaded.

### Geometry / Wasm

- `src/math/extractVertices.ts`: converts a `BufferGeometry` position attribute into a flat `Float32Array`.
- `src/math/WasmEngine.ts`: browser-side loader/wrapper for the geometry Wasm module that scales vertex arrays.
- `src/math/geometryModule.ts`: low-level standalone Wasm loader for the geometry scaling module.
- `src/math/geometry.cpp`: C++ in-place vertex scaling functions compiled to `geometry.wasm`.
- `src/math/stl_parser.cpp`: C++ binary STL parser compiled to `stl_parser.wasm`.

### Worker Pipeline

- `src/workers/stlWorker.ts`: dedicated worker that lazily initializes the STL parser Wasm module, parses STL bytes off the UI thread, constructs a temporary `BufferGeometry`, builds a `MeshBVH`, serializes it, and transfers the raw arrays plus BVH buffers back to the main thread.
- `src/workers/stlParserModule.ts`: low-level Wasm instantiation wrapper for `stl_parser.wasm`, including memory access helpers.

### Composables / Services

- `src/composables/useStlImport.ts`: owns file queueing, worker coordination, BVH deserialization, geometry caching, camera framing, selection updates, and assembly resource disposal.
- `src/composables/useAssemblyTools.ts`: owns Wasm-based assembly scaling and vertex extraction helpers.
- `src/composables/useVersioning.ts`: owns manifest generation, STL export/import, Git history reads, and assembly restore flows. Restored STL files are currently reparsed with Three.js `STLLoader` and have their BVH computed on the main thread.

### Static/Public Assets

- `public/stl_parser.wasm`: checked-in parser Wasm artifact used by the worker.
- `public/geometry.wasm`: expected runtime asset for assembly scaling, generated by the Wasm build scripts.

### Tauri Shell

- `src-tauri/src/main.rs`: native entry point.
- `src-tauri/src/lib.rs`: Tauri builder, plugin registration, and template `greet` command.
- `src-tauri/tauri.conf.json`: app metadata, build hooks, bundle settings, and window configuration.
- `src-tauri/capabilities/default.json`: permissions, including app-data filesystem access and `git` execution through the shell plugin.
- `src-tauri/Cargo.toml`: Rust dependencies and plugin declarations.

## Data Flow & State Management

The app uses module-level Vue refs in `src/store.ts` as its shared state layer. There is no dedicated store framework, reducer pattern, or backend persistence model for in-memory state.

Primary state objects:

- `assembly`: array of loaded parts, each containing display name, source path, raw `BufferGeometry`, raw `MeshStandardMaterial`, position, rotation, and visibility.
- `selectedItemId`: current selection in both the sidebar and scene transform controls.
- `activeProjectName`: project/versioning root name, typically derived from the first imported STL.
- `activeMeshName`: filename of the most recently imported or restored mesh, used for UI display.
- `isWireframe`: global display toggle.
- `scaleX`, `scaleY`, `scaleZ`: global scale factors for Wasm-based scaling.
- `cameraPosition`, `controlsTarget`: camera framing state used by the scene.

### Import Flow

1. The user selects one or more `.stl` files in `Sidebar.vue`.
2. `useStlImport.ts` reads each file into memory through Tauri's filesystem plugin.
3. A queue in `useStlImport.ts` dispatches work up to a concurrency limit based on `navigator.hardwareConcurrency`.
4. Each file is sent to `src/workers/stlWorker.ts`.
5. The worker loads `stl_parser.wasm` through `stlParserModule.ts`.
6. The Wasm parser returns flat vertex positions and normals.
7. Inside the worker, a temporary `BufferGeometry` is created from the positions array and `three-mesh-bvh` builds a `MeshBVH`, which is then serialized.
8. The worker transfers the positions buffer, normals buffer, BVH root buffers, and BVH index buffer back to the main thread without copying when possible.
9. The UI reconstructs the final `BufferGeometry`, restores the transferred index buffer if present, deserializes the BVH onto `geometry.boundsTree`, computes bounds, wraps the geometry in `markRaw()`, creates a raw per-part material, and appends an `AssemblyItem` to `assembly`.
10. After all files finish, the app frames the camera to the combined bounding box.

The import path also keeps a geometry cache keyed by source path so repeated imports of the same file can share GPU geometry until the last referencing part is removed.

### Render Flow

- `Scene.vue` observes the shared refs directly.
- Each `assembly` item becomes a `TresMesh`.
- The mesh binds a stored raw material instead of creating a reactive material subtree in the template.
- Mesh raycasting is accelerated through the global `THREE.Mesh.prototype.raycast = acceleratedRaycast` patch established during app startup.
- Global render flags like wireframe, selection color, and camera target are synchronized from store state.

### Geometry Transformation Flow

1. The user changes `scaleX/Y/Z` in the sidebar.
2. `useAssemblyTools.ts` creates a `WasmEngine`.
3. `WasmEngine` loads `geometry.wasm` through `geometryModule.ts`.
4. Each mesh position buffer is copied into Wasm memory, scaled in C++, copied back, and written into the existing Three.js attribute array.
5. The geometry is marked dirty and normals are recomputed.

This is an in-memory mutation path; the transformed mesh is not automatically persisted unless the user saves a version afterward.

### Versioning / Persistence Flow

1. The current assembly is converted into a manifest plus one STL file per part.
2. Those files are written to `appDataDir()/STL_Viewer_Projects/<project-name>/`.
3. The app initializes a Git repository there if needed, configures a local identity, stages the files, and creates a commit.
4. The Git log is read back through the Tauri shell plugin and shown in the sidebar.
5. On checkout, the selected historical manifest and STL files are restored from Git, re-read from disk, parsed with Three.js `STLLoader`, and used to rebuild the in-memory assembly.
6. The restore path currently computes a fresh BVH on the main thread for the `STLLoader` geometry rather than reusing the worker-based import path.
7. Before replacing the live assembly, existing raw geometries and materials are explicitly disposed to avoid leaking WebGL resources.

State persistence is therefore split into two layers:

- Session state: Vue refs in memory only.
- Saved mesh history: STL files plus Git metadata under the Tauri app-data directory.

## Extension Points

- `src/store.ts`: best place to add new shared view settings, selection state, metadata, or per-part editing data.
- `src/components/Sidebar.vue`: current home for most user workflows. New import/export actions, mesh metadata panels, and history controls would likely start here.
- `src/components/Scene.vue`: natural place for selection, gizmos, clipping, measurement tools, camera presets, or richer material presentation.
- `src/workers/stlWorker.ts` and `src/workers/stlParserModule.ts`: extension seam for more parsing features, progress reporting, cancellation, ASCII STL support, richer geometry metadata extraction, or moving additional geometry preprocessing off the main thread.
- `src/setupThreeMeshBvh.ts`: central place to expand or alter global Three.js prototype integrations if raycast behavior or geometry acceleration strategy changes.
- `src/math/geometry.cpp` and `src/math/WasmEngine.ts`: intended expansion point for more performance-sensitive mesh operations such as translation, rotation, welding, simplification, bounding metrics, or analysis kernels.
- `src-tauri/src/lib.rs`: best place to add native commands if future features need stronger filesystem orchestration, packaged Git integration, background jobs, or OS-native capabilities.
- `src-tauri/capabilities/default.json`: must evolve alongside any new Tauri plugin usage or native command surface.

## Practical Notes For Future Work

- The codebase has already started moving core workflows out of `Sidebar.vue` into composables, but the UI still coordinates many flows and remains an integration-heavy surface.
- The current shared state model is simple and easy to follow, but it has no undo/redo and no persisted workspace state between launches.
- Because Three.js scene payloads are intentionally marked raw to avoid Vue proxy overhead, any future code that stores meshes, materials, or geometries in shared state must also take responsibility for manual disposal.
- The most performance-sensitive import hotspot, BVH generation for high-poly STL meshes, has been moved into the worker import path; however, version restore still rebuilds BVHs on the main thread.
- The project already has a strong path for adding more Wasm-powered geometry operations, and that appears to be a deliberate architectural direction.
- Because Git execution is permissioned through Tauri shell capabilities, versioning features are tightly coupled to desktop packaging and app-data filesystem access rather than a pure web deployment model.
