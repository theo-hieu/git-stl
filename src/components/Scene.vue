<template>
  <div class="scene-container">
    <div v-if="selectedObject" class="transform-toolbar">
      <button
        class="transform-btn"
        :class="{ active: transformMode === 'translate' }"
        @click="transformMode = 'translate'"
      >
        Move
      </button>
      <button
        class="transform-btn"
        :class="{ active: transformMode === 'rotate' }"
        @click="transformMode = 'rotate'"
      >
        Rotate
      </button>
    </div>

    <TresCanvas clear-color="#0f172a" style="width: 100%; height: 100%;">
      <TresPerspectiveCamera :position="cameraPosition" />
      <OrbitControls :target="controlsTarget" v-bind="orbitControlsProps" />
      <TresDirectionalLight :position="[5, 5, 5]" :intensity="1" />
      <TresAmbientLight :intensity="0.5" />

      <TresMesh
        v-for="item in assembly"
        :key="item.id"
        :ref="(instance) => setMeshRef(item.id, instance)"
        :geometry="item.geometry"
        :position="item.position"
        :rotation="item.rotation"
        :visible="item.visible"
        @click="selectItem(item.id)"
      >
        <TresMeshStandardMaterial
          :color="item.id === selectedItemId ? '#60a5fa' : '#3b82f6'"
          :wireframe="isWireframe"
        />
      </TresMesh>

      <TransformControls
        v-if="selectedObject"
        :object="selectedObject"
        :mode="transformMode"
        @dragging="handleTransformDragging"
        @mouse-up="commitSelectedTransform"
      />

      <AnimatedBox v-if="assembly.length === 0" />
    </TresCanvas>
  </div>
</template>

<script setup lang="ts">
import { isObject3D } from "@tresjs/core";
import { OrbitControls, TransformControls } from "@tresjs/cientos";
import type { Object3D } from "three";
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import { useStlImport } from "../composables/useStlImport";
import AnimatedBox from "./AnimatedBox.vue";
import {
  assembly,
  type AssemblyVector3,
  cameraPosition,
  controlsTarget,
  isWireframe,
  selectedItemId,
} from "../store";

type TransformMode = "translate" | "rotate";

const { selectItem, updateItemTransform } = useStlImport();
const transformMode = ref<TransformMode>("translate");
const isDraggingGizmo = ref(false);
const meshRefs = new Map<string, Object3D>();
const selectedObject = shallowRef<Object3D | null>(null);
const orbitControlsProps = computed(() => ({
  enabled: !isDraggingGizmo.value,
  enablePan: !isDraggingGizmo.value,
  enableRotate: !isDraggingGizmo.value,
  enableZoom: !isDraggingGizmo.value,
}));

async function syncSelectedObject(): Promise<void> {
  await nextTick();

  const nextObject = selectedItemId.value
    ? meshRefs.get(selectedItemId.value) ?? null
    : null;

  if (selectedObject.value !== nextObject) {
    selectedObject.value = nextObject;
  }

  if (!nextObject) {
    isDraggingGizmo.value = false;
  }
}

watch(
  [selectedItemId, () => assembly.value.length],
  () => {
    void syncSelectedObject();
  },
  { immediate: true, flush: "post" },
);

function setMeshRef(itemId: string, instance: unknown): void {
  if (isObject3D(instance)) {
    meshRefs.set(itemId, instance);
  } else {
    meshRefs.delete(itemId);
  }
}

function commitSelectedTransform(): void {
  const itemId = selectedItemId.value;
  if (!itemId) {
    return;
  }

  const selectedMesh = selectedObject.value ?? meshRefs.get(itemId);

  if (!selectedMesh) {
    return;
  }

  const position: AssemblyVector3 = [
    selectedMesh.position.x,
    selectedMesh.position.y,
    selectedMesh.position.z,
  ];
  const rotation: AssemblyVector3 = [
    selectedMesh.rotation.x,
    selectedMesh.rotation.y,
    selectedMesh.rotation.z,
  ];

  updateItemTransform(itemId, position, rotation);
}

function handleTransformDragging(isDragging: boolean): void {
  isDraggingGizmo.value = isDragging;

  if (!isDragging) {
    commitSelectedTransform();
  }
}
</script>

<style scoped>
.scene-container {
  flex-grow: 1;
  position: relative;
  height: 100vh;
}

.transform-toolbar {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 10;
  display: flex;
  gap: 8px;
  padding: 8px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.78);
  border: 1px solid rgba(148, 163, 184, 0.2);
  backdrop-filter: blur(8px);
}

.transform-btn {
  border: none;
  border-radius: 999px;
  padding: 8px 12px;
  background: rgba(51, 65, 85, 0.8);
  color: #e2e8f0;
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 600;
}

.transform-btn.active {
  background: #2563eb;
  color: #eff6ff;
}
</style>
