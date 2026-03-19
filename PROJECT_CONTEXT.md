# Project Context

## Project Overview

This project is a desktop STL assembly viewer built with Vue, Three.js, and Tauri. Its main purpose is to let a user import one or more STL files, inspect them together as a simple assembly, adjust visibility and placement, apply geometry scaling, manage saved local projects, and save full-assembly snapshots into isolated Git-backed project folders under the app data directory.

The product value is in combining a lightweight desktop UI with local-native file access, fast WebAssembly-based STL parsing, worker-generated BVH acceleration for high-poly meshes, lightweight local project management, and simple revision tracking for mesh edits without requiring a remote backend.

## Tech Stack & Architecture

- Frontend: Vue 3 with `<script setup>` single-file components and TypeScript.
- Rendering: Three.js via TresJS (`@tresjs/core` and `@tresjs/cientos`) for the 3D scene, camera, lights, and controls.
- Spatial acceleration: `three-mesh-bvh` for accelerated mesh raycasting against imported STL geometry.
- Desktop shell: Tauri 2, with plugins for dialog, filesystem access, opener, and shell execution.
- Geometry processing: Two C++ modules compiled with Emscripten/WebAssembly.
- Build tooling: Vite 6, `vue-tsc`, TypeScript bundler-mode config, PowerShell and Bash helper scripts for Wasm compilation.

Architecturally, the app is a small component-based desktop client with a few clear subsystems:

- UI shell: `App.vue` composes the sidebar, scene, and project browser.
- Shared reactive state: `src/store.ts` exposes app-wide Vue refs instead of using Pinia/Vuex.
- Import pipeline: `useStlImport.ts` reads STL bytes through Tauri, coordinates a worker queue, reconstructs raw Three.js `BufferGeometry` instances, and attaches worker-generated BVH data for fast raycasting.
- Rendering pipeline: the scene reacts directly to the shared assembly state while keeping heavyweight Three.js objects out of Vue's deep proxy system via `markRaw()`.
- Persistence/versioning pipeline: the full assembly is represented by a `manifest.json`, a `thumbnail.png`, and referenced STL files under Tauri app data and versioned per project with Git repositories managed through native Tauri commands.
- Project-browser pipeline: saved projects are listed from Rust, thumbnail bytes are loaded from AppData on the frontend, and projects can be opened or deleted from a dedicated modal UI.

The Rust/Tauri layer now owns Git repository orchestration and commit/diff history commands, while the frontend TypeScript layer still owns most scene, import, project-browser, and manifest serialization logic.

## Core Capabilities & Features

- Open multiple STL files at once through a native file dialog.
- Parse STL data off the main thread using a dedicated worker and a Wasm STL parser.
- Generate serialized `three-mesh-bvh` acceleration structures off the main thread during STL import.
- Display all loaded parts together in a Three.js/TresJS 3D scene.
- Show a placeholder animated box when no geometry is loaded.
- Reset the current session with a "New Project" action without restarting the app.
- Toggle wireframe rendering for the full assembly.
- Toggle per-part visibility.
- Adjust per-part XYZ position values from the sidebar.
- Filter the assembly tree by part name or stable id.
- Remove individual parts from the assembly and explicitly dispose of their geometry and material.
- Automatically frame the camera around the loaded assembly after import completes.
- Apply assembly-wide XYZ scaling using a separate Wasm geometry module.
- Extract raw vertex data from geometry for future Wasm/debug workflows.
- Save versions of the current assembly into an isolated app-data project folder backed by Git commits.
- Capture a scene thumbnail on save and store it as `thumbnail.png` in each project folder.
- Read Git history for the current project and restore a saved revision into the scene.
- Browse saved local projects in a dedicated modal UI.
- Render thumbnail previews for saved projects in the project browser.
- Delete saved projects from the project browser with an explicit confirmation dialog.
- Avoid rewriting STL files on routine saves unless a part's geometry was actually modified.

Important current constraints:

- The custom worker parser is built for binary STL parsing; there is no custom ASCII STL path in the worker.
- Three.js `BufferGeometry` and `MeshStandardMaterial` instances stored alongside assembly items must stay raw and must be explicitly disposed when removed or replaced.
- Imported STL geometries arrive with a worker-generated serialized BVH that is deserialized on the main thread and assigned to `geometry.boundsTree`; disposal must also clear the BVH via `disposeBoundsTree()`.
- The scaling path depends on `public/geometry.wasm`; that artifact is produced by the Wasm build scripts and does not appear in the current tracked file list.
- Version commits are created through `git2` on the Rust side, while checkout still uses the shell plugin to restore a selected tree into the working directory.
- Project browser thumbnails currently use frontend AppData reads plus blob URLs rather than Tauri's asset protocol.

## Key File Structure & Modules

### Root

- `package.json`: frontend and Tauri dependencies plus `dev`, `build`, `preview`, and `tauri` scripts.
- `vite.config.ts`: Vue plugin setup and Tauri-specific dev-server behavior.
- `build-wasm.ps1`, `build-wasm.sh`: compile C++ sources into browser-loadable Wasm assets in `public/`.
- `index.html`: Vite entry page.
- `README.md`: still mostly template content rather than project-specific documentation.

### Frontend App

- `src/main.ts`: bootstraps Vue, registers TresJS, and loads the shared Three/BVH prototype patch module.
- `src/App.vue`: top-level layout with a fixed sidebar, the 3D scene, and the project browser modal.
- `src/setupThreeMeshBvh.ts`: patches Three.js prototypes so meshes use `acceleratedRaycast` and geometries expose `computeBoundsTree` / `disposeBoundsTree`.
- `src/style.css`: global page sizing and background styling.
- `src/store.ts`: shared reactive application state plus the `AssemblyItem` factory that raw-wraps Three.js payloads before they enter Vue state. It also exports default camera/controls targets used when resetting the viewer.

### UI Components

- `src/components/Sidebar.vue`: primary control surface. Handles import triggers, session reset, version save/history, assembly tree search, assembly transform controls, removal, and debug/Wasm actions.
- `src/components/Scene.vue`: renders camera, controls, lights, and one mesh per loaded assembly item, binding each part's raw material directly. It applies stored `position`, `rotation`, and `scale` from assembly state and exposes transform controls for translate/rotate edits.
- `src/components/AnimatedBox.vue`: empty-state visual shown when no STL data is loaded.
- `src/components/ProjectBrowser.vue`: modal browser for saved local projects, including search, thumbnail preview, open, and delete-with-confirmation flows.
- `src/components/SceneCaptureBridge.vue`: small TresJS child component that reaches into the active renderer/canvas so the frontend can capture PNG thumbnails safely before save.

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
- `src/composables/useAssemblyTools.ts`: owns Wasm-based assembly scaling and vertex extraction helpers. Assembly-wide scaling also marks parts as geometry-dirty so version saves know when binary STL output must be regenerated.
- `src/composables/useVersioning.ts`: owns manifest generation, thumbnail capture handoff, selective STL materialization, Git history reads, session reset, and assembly restore flows. Restore reuses the worker-based STL import path and then reapplies manifest-authored ids, transforms, visibility, and scale.
- `src/composables/useProjectBrowser.ts`: owns saved-project listing, search, thumbnail loading, project deletion, and project restore orchestration.
- `src/composables/useGitDiff.ts`: owns commit diff lookup plus overlay/split diff visualization state for version comparisons.
- `src/composables/useSceneThumbnail.ts`: stores the active scene thumbnail capture handler used by save flows.

### Static/Public Assets

- `public/stl_parser.wasm`: checked-in parser Wasm artifact used by the worker.
- `public/geometry.wasm`: expected runtime asset for assembly scaling, generated by the Wasm build scripts.

### Tauri Shell

- `src-tauri/src/main.rs`: native entry point.
- `src-tauri/src/lib.rs`: Tauri builder, plugin registration, `git2`-backed commit orchestration, native Git history/diff/blob-reading commands, project listing, and thumbnail persistence.
- `src-tauri/tauri.conf.json`: app metadata, build hooks, bundle settings, and window configuration.
- `src-tauri/capabilities/default.json`: permissions, including app-data filesystem access and `git` execution through the shell plugin.
- `src-tauri/Cargo.toml`: Rust dependencies and plugin declarations.

## Data Flow & State Management

The app uses module-level Vue refs in `src/store.ts` as its shared state layer. There is no dedicated store framework, reducer pattern, or backend persistence model for in-memory state.

Primary state objects:

- `assembly`: array of loaded parts, each containing display name, source path, raw `BufferGeometry`, raw `MeshStandardMaterial`, position, rotation, scale, visibility, and a `geometryModified` flag.
- `selectedItemId`: current selection in both the sidebar and scene transform controls.
- `activeProjectName`: current project/versioning root name. A `null` value means the app is in File Mode rather than Project Mode.
- `activeMeshName`: filename of the most recently imported or restored mesh, used for UI display.
- `isWireframe`: global display toggle.
- `scaleX`, `scaleY`, `scaleZ`: global scale factors for Wasm-based scaling.
- `cameraPosition`, `controlsTarget`: camera framing state used by the scene.
- `defaultCameraPosition`, `defaultControlsTarget`: viewer reset defaults used to restore the empty-session camera state.

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
- When no parts are loaded and diff mode is off, the scene renders `AnimatedBox.vue` as the empty-state placeholder.

### Geometry Transformation Flow

1. The user changes `scaleX/Y/Z` in the sidebar.
2. `useAssemblyTools.ts` creates a `WasmEngine`.
3. `WasmEngine` loads `geometry.wasm` through `geometryModule.ts`.
4. Each mesh position buffer is copied into Wasm memory, scaled in C++, copied back, and written into the existing Three.js attribute array.
5. The geometry is marked dirty, normals are recomputed, and the owning assembly items are flagged as `geometryModified` for the next version save.

This is an in-memory mutation path; the transformed mesh is not automatically persisted unless the user saves a version afterward.

### Versioning / Persistence Flow

1. The current assembly is serialized into a lightweight `manifest.json` containing each part's stable id, file name, visibility, and `position` / `rotation` / `scale`.
2. Project files live under `appDataDir()/STL_Viewer_Projects/<project-name>/`, with STL binaries stored in `parts/` and a scene snapshot stored as `thumbnail.png`.
3. On save, the frontend captures the active TresJS canvas as a PNG data URL, then rewrites `manifest.json`; STL files are only written when the corresponding part is missing from the project folder or its `geometryModified` flag is set.
4. The frontend invokes the native `commit_assembly` Tauri command with the project name, commit message, and optional thumbnail payload.
5. Rust resolves the isolated project directory, writes `thumbnail.png` when provided, initializes or opens the per-project repository with `git2`, stages the working tree, writes the index tree, and creates a commit with a generic local signature.
6. Git history, commit diffs, and blob reads are served by native Tauri commands and shown in the sidebar.
7. The project browser reads local project summaries from Rust, loads thumbnails from AppData on the frontend, and can delete an entire project folder recursively after explicit user confirmation.
8. On checkout, the selected revision is restored into the project working tree, the manifest is read from disk, and the referenced STL files are reparsed through the worker-based import pipeline before manifest state is reapplied.
9. Before replacing or resetting the live assembly, existing raw geometries and materials are explicitly disposed to avoid leaking WebGL resources.

State persistence is therefore split into two layers:

- Session state: Vue refs in memory only.
- Saved mesh history: per-project manifests, thumbnails, STL files, and Git metadata under the Tauri app-data directory.

## Extension Points

- `src/store.ts`: best place to add new shared view settings, selection state, metadata, or per-part editing data.
- `src/components/Sidebar.vue`: current home for most user workflows. New import/export actions, mesh metadata panels, and history controls would likely start here.
- `src/components/Scene.vue`: natural place for selection, gizmos, clipping, measurement tools, camera presets, richer material presentation, or alternative empty-state visuals.
- `src/components/ProjectBrowser.vue`: natural home for richer project metadata, preview cards, sorting modes, pin/favorite flows, and destructive-action safeguards.
- `src/workers/stlWorker.ts` and `src/workers/stlParserModule.ts`: extension seam for more parsing features, progress reporting, cancellation, ASCII STL support, richer geometry metadata extraction, or moving additional geometry preprocessing off the main thread.
- `src/setupThreeMeshBvh.ts`: central place to expand or alter global Three.js prototype integrations if raycast behavior or geometry acceleration strategy changes.
- `src/math/geometry.cpp` and `src/math/WasmEngine.ts`: intended expansion point for more performance-sensitive mesh operations such as translation, rotation, welding, simplification, bounding metrics, or analysis kernels.
- `src-tauri/src/lib.rs`: best place to add native commands if future features need stronger filesystem orchestration, packaged Git integration, thumbnail/media handling, background jobs, or OS-native capabilities.
- `src-tauri/capabilities/default.json`: must evolve alongside any new Tauri plugin usage or native command surface.

## Practical Notes For Future Work

- The codebase has already started moving core workflows out of `Sidebar.vue` into composables, but the UI still coordinates many flows and remains an integration-heavy surface.
- The current shared state model is simple and easy to follow, but it has no undo/redo and no persisted workspace state between launches.
- Because Three.js scene payloads are intentionally marked raw to avoid Vue proxy overhead, any future code that stores meshes, materials, or geometries in shared state must also take responsibility for manual disposal.
- The most performance-sensitive import hotspot, BVH generation for high-poly STL meshes, stays in the worker import path, and version restore now reuses that same path instead of introducing a separate main-thread parser.
- The project already has a strong path for adding more Wasm-powered geometry operations, and that appears to be a deliberate architectural direction.
- Thumbnail preview in the project browser currently depends on frontend reads from AppData and blob URL creation rather than Tauri's asset protocol.
- Versioning is now split between native `git2` commands for commit/history/diff access and the shell plugin for checkout, so Git-related behavior is tightly coupled to desktop packaging and app-data filesystem access rather than a pure web deployment model.
