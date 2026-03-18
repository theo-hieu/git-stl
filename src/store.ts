import { computed, ref } from "vue";
import type { BufferGeometry } from "three";

export type AssemblyVector3 = [number, number, number];

let assemblyItemSequence = 0;

function createAssemblyItemId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  assemblyItemSequence += 1;
  return `assembly-item-${assemblyItemSequence}`;
}

export interface AssemblyItem {
  id: string;
  name: string;
  sourcePath: string;
  geometry: BufferGeometry;
  position: AssemblyVector3;
  rotation: AssemblyVector3;
  visible: boolean;
}

export interface CreateAssemblyItemInput {
  id?: string;
  name: string;
  sourcePath: string;
  geometry: BufferGeometry;
  position?: AssemblyVector3;
  rotation?: AssemblyVector3;
  visible?: boolean;
}

export function createAssemblyItem(
  input: CreateAssemblyItemInput,
): AssemblyItem {
  return {
    id: input.id ?? createAssemblyItemId(),
    name: input.name,
    sourcePath: input.sourcePath,
    geometry: input.geometry,
    position: input.position ?? [0, 0, 0],
    rotation: input.rotation ?? [0, 0, 0],
    visible: input.visible ?? true,
  };
}

export const assembly = ref<AssemblyItem[]>([]);
export const selectedItemId = ref<string | null>(null);
export const selectedAssemblyItem = computed<AssemblyItem | null>(() => {
  if (!selectedItemId.value) {
    return null;
  }

  return assembly.value.find((item) => item.id === selectedItemId.value) ?? null;
});

export const activeProjectName = ref<string | null>(null);
export const activeMeshName = ref<string | null>(null);
export const isWireframe = ref(false);
export const scaleX = ref(1);
export const scaleY = ref(1);
export const scaleZ = ref(1);
export const cameraPosition = ref<AssemblyVector3>([50, 50, 50]);
export const controlsTarget = ref<AssemblyVector3>([0, 0, 0]);
