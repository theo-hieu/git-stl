import { ref } from "vue";
import type { BufferGeometry } from "three";

// ── Assembly ──────────────────────────────────────────────────────────────────

/** A single loaded STL part inside the multi-part assembly. */
export interface AssemblyItem {
  /** Display name (filename) */
  name: string;
  /** Three.js BufferGeometry parsed from the STL */
  geometry: BufferGeometry;
  /** Relative XYZ position offset (TresMesh :position) */
  position: [number, number, number];
  /** Relative XYZ Euler rotation in radians (TresMesh :rotation) */
  rotation: [number, number, number];
  /** Whether the mesh is visible in the 3D canvas */
  visible: boolean;
}

/**
 * Reactive array of all loaded STL parts.
 * "Open File" appends to this; the TresJS canvas renders every item.
 */
export const assembly = ref<AssemblyItem[]>([]);

// ── Active file metadata ──────────────────────────────────────────────────────

/** Filename of the most-recently-opened STL (used for git versioning). */
export const activeMeshName = ref<string | null>(null);

// ── View options ──────────────────────────────────────────────────────────────

export const isWireframe = ref(false);

// ── XYZ Scale factors (shared between Sidebar and any future consumer) ────────

export const scaleX = ref(1);
export const scaleY = ref(1);
export const scaleZ = ref(1);

// ── Camera / OrbitControls state ──────────────────────────────────────────────

/** World-space position of TresPerspectiveCamera. Updated by "Frame Assembly". */
export const cameraPosition = ref<[number, number, number]>([50, 50, 50]);

/** OrbitControls look-at target. Updated by "Frame Assembly". */
export const controlsTarget = ref<[number, number, number]>([0, 0, 0]);
