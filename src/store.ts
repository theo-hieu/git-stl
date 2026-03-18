import { ref } from "vue";
import type { BufferGeometry } from "three";

export const activeMeshGeometry = ref<BufferGeometry | null>(null);
export const activeMeshName = ref<string | null>(null);
export const isWireframe = ref(false);
