<template>
  <div class="scene-container">
    <div
      v-if="isDiffMode && diffVisualizationMode === 'split'"
      class="split-guide"
      aria-hidden="true"
    >
      <span class="split-label split-label-base">Base</span>
      <span class="split-label split-label-head">Head</span>
    </div>

    <div v-if="selectedObject && !isDiffMode" class="transform-toolbar">
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
        :material="item.material"
        :position="item.position"
        :rotation="item.rotation"
        :scale="item.scale"
        :visible="!isDiffMode && item.visible"
        @click="selectItem(item.id)"
      />

      <TresGroup v-if="isDiffMode">
        <TresGroup v-for="overlay in diffOverlays" :key="overlay.id">
          <TresMesh
            v-if="overlay.oldGeometry && overlay.oldMaterial"
            :geometry="overlay.oldGeometry"
            :material="overlay.oldMaterial"
            :position="getOverlayPosition(overlay.oldPosition, 'base')"
            :rotation="overlay.oldRotation"
          />
          <TresMesh
            v-if="overlay.newGeometry && overlay.newMaterial"
            :geometry="overlay.newGeometry"
            :material="overlay.newMaterial"
            :position="getOverlayPosition(overlay.newPosition, 'head')"
            :rotation="overlay.newRotation"
          />
        </TresGroup>
      </TresGroup>

      <TransformControls
        v-if="selectedObject && !isDiffMode"
        :object="selectedObject"
        :mode="transformMode"
        @dragging="handleTransformDragging"
        @mouse-up="commitSelectedTransform"
      />

      <AnimatedBox v-if="assembly.length === 0 && !isDiffMode" />
    </TresCanvas>
  </div>
</template>

<script setup lang="ts">
import { isObject3D } from "@tresjs/core";
import { OrbitControls, TransformControls } from "@tresjs/cientos";
import type { Object3D } from "three";
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import { useGitDiff } from "../composables/useGitDiff";
import { useStlImport } from "../composables/useStlImport";
import AnimatedBox from "./AnimatedBox.vue";
import {
  assembly,
  type AssemblyVector3,
  cameraPosition,
  controlsTarget,
  defaultPartColor,
  isWireframe,
  selectedPartColor,
  selectedItemId,
} from "../store";

type TransformMode = "translate" | "rotate";

const { selectItem, updateItemTransform } = useStlImport();
const { diffOverlays, diffSplitOffset, diffVisualizationMode, isDiffMode } =
  useGitDiff();
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

  if (isDiffMode.value) {
    selectedObject.value = null;
    isDraggingGizmo.value = false;
    return;
  }

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

function syncAssemblyMaterials(): void {
  for (const item of assembly.value) {
    item.material.color.set(
      item.id === selectedItemId.value ? selectedPartColor : defaultPartColor,
    );

    if (item.material.wireframe !== isWireframe.value) {
      item.material.wireframe = isWireframe.value;
      item.material.needsUpdate = true;
    }
  }
}

watch(
  [selectedItemId, () => assembly.value.length, isDiffMode],
  () => {
    void syncSelectedObject();
  },
  { immediate: true, flush: "post" },
);

watch(
  [selectedItemId, isWireframe, () => assembly.value.length],
  () => {
    syncAssemblyMaterials();
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

function getOverlayPosition(
  position: AssemblyVector3,
  side: "base" | "head",
): AssemblyVector3 {
  if (diffVisualizationMode.value !== "split") {
    return position;
  }

  return [
    position[0] + (side === "base" ? -diffSplitOffset.value : diffSplitOffset.value),
    position[1],
    position[2],
  ];
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

.split-guide {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 8;
}

.split-guide::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  background: linear-gradient(
    180deg,
    rgba(248, 250, 252, 0),
    rgba(248, 250, 252, 0.5),
    rgba(248, 250, 252, 0)
  );
}

.split-label {
  position: absolute;
  top: 16px;
  padding: 6px 10px;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #f8fafc;
  background: rgba(15, 23, 42, 0.8);
  border: 1px solid rgba(148, 163, 184, 0.25);
  backdrop-filter: blur(8px);
}

.split-label-base {
  left: calc(50% - 108px);
  color: #fca5a5;
}

.split-label-head {
  left: calc(50% + 20px);
  color: #86efac;
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
