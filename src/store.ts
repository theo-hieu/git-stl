import { computed, markRaw, ref, type Ref } from "vue";
import { MeshStandardMaterial, type BufferGeometry } from "three";

export type AssemblyVector3 = [number, number, number];
export const defaultPartColor = "#3b82f6";
export const selectedPartColor = "#60a5fa";

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
  material: MeshStandardMaterial;
  position: AssemblyVector3;
  rotation: AssemblyVector3;
  visible: boolean;
}

export interface CreateAssemblyItemInput {
  id?: string;
  name: string;
  sourcePath: string;
  geometry: BufferGeometry;
  material?: MeshStandardMaterial;
  position?: AssemblyVector3;
  rotation?: AssemblyVector3;
  visible?: boolean;
}

function createAssemblyItemMaterial(): MeshStandardMaterial {
  return markRaw(
    new MeshStandardMaterial({
      color: defaultPartColor,
    }),
  );
}

export function createAssemblyItem(
  input: CreateAssemblyItemInput,
): AssemblyItem {
  return {
    id: input.id ?? createAssemblyItemId(),
    name: input.name,
    sourcePath: input.sourcePath,
    geometry: markRaw(input.geometry),
    material: input.material ? markRaw(input.material) : createAssemblyItemMaterial(),
    position: input.position ?? [0, 0, 0],
    rotation: input.rotation ?? [0, 0, 0],
    visible: input.visible ?? true,
  };
}

export const assembly = ref<AssemblyItem[]>([]) as Ref<AssemblyItem[]>;
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
