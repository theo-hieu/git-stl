<template>
  <div class="scene-container">
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
      <DiffShaderWarmup />
      <SceneCaptureBridge />
      <TresPerspectiveCamera :position="cameraPosition" />
      <OrbitControls :target="controlsTarget" v-bind="orbitControlsProps" />
      <TresDirectionalLight :position="[5, 5, 5]" :intensity="1" />
      <TresAmbientLight :intensity="0.5" />

      <TresGroup v-if="!isDiffMode">
        <TresMesh
          v-for="item in assembly"
          :key="item.id"
          :ref="(instance) => setMeshRef(item.id, instance)"
          :geometry="item.geometry"
          :material="item.material"
          :position="item.position"
          :rotation="item.rotation"
          :scale="item.scale"
          :visible="item.visible"
          @click="selectItem(item.id)"
        />
      </TresGroup>

      <TresGroup v-if="isDiffMode">
        <TresGroup v-if="diffViewMode === 'overlay'">
          <TresGroup
            v-for="item in diffItems"
            :key="`${item.id}-overlay`"
            :visible="item.visible"
          >
            <TresMesh
              v-if="item.oldGeometry && item.oldMaterial"
              :geometry="item.oldGeometry"
              :material="item.oldMaterial"
              :position="item.oldPosition"
              :rotation="item.oldRotation"
              :scale="item.oldScale"
            />
            <TresLineSegments
              v-if="item.oldEdgesGeometry && item.oldEdgeMaterial"
              :geometry="item.oldEdgesGeometry"
              :material="item.oldEdgeMaterial"
              :position="item.oldPosition"
              :rotation="item.oldRotation"
              :scale="item.oldScale"
            />
            <TresMesh
              v-if="item.newGeometry && item.newMaterial"
              :geometry="item.newGeometry"
              :material="item.newMaterial"
              :position="item.newPosition"
              :rotation="item.newRotation"
              :scale="item.newScale"
            />
            <TresLineSegments
              v-if="item.newEdgesGeometry && item.newEdgeMaterial"
              :geometry="item.newEdgesGeometry"
              :material="item.newEdgeMaterial"
              :position="item.newPosition"
              :rotation="item.newRotation"
              :scale="item.newScale"
            />
          </TresGroup>
        </TresGroup>

        <TresGroup v-else>
          <TresGroup
            v-for="item in diffItems"
            :key="`${item.id}-csg`"
            :visible="item.visible"
          >
            <TresMesh
              v-if="getCsgAddedGeometry(item)"
              :geometry="getCsgAddedGeometry(item)"
              :material="diffCsgAddedMaterial"
              :position="item.newPosition"
              :rotation="item.newRotation"
              :scale="item.newScale"
            />
            <TresMesh
              v-if="getCsgRemovedGeometry(item)"
              :geometry="getCsgRemovedGeometry(item)"
              :material="diffCsgRemovedMaterial"
              :position="item.oldPosition"
              :rotation="item.oldRotation"
              :scale="item.oldScale"
            />
            <TresMesh
              v-if="getCsgUnchangedGeometry(item)"
              :geometry="getCsgUnchangedGeometry(item)"
              :material="diffCsgUnchangedMaterial"
              :position="item.newPosition"
              :rotation="item.newRotation"
              :scale="item.newScale"
            />
          </TresGroup>
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
import type { BufferGeometry, Object3D } from "three";
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import { useGitDiff, type DiffItem } from "../composables/useGitDiff";
import { useStlImport } from "../composables/useStlImport";
import {
  diffCsgAddedMaterial,
  diffCsgRemovedMaterial,
  diffCsgUnchangedMaterial,
} from "../materials/diffMaterials";
import AnimatedBox from "./AnimatedBox.vue";
import DiffShaderWarmup from "./DiffShaderWarmup.vue";
import SceneCaptureBridge from "./SceneCaptureBridge.vue";
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
const { diffItems, diffViewMode, isDiffMode } = useGitDiff();
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

function getCsgAddedGeometry(item: DiffItem): BufferGeometry | undefined {
  if (item.status === "added") {
    return item.newGeometry ?? undefined;
  }

  return item.csgAdded ?? undefined;
}

function getCsgRemovedGeometry(item: DiffItem): BufferGeometry | undefined {
  if (item.status === "removed") {
    return item.oldGeometry ?? undefined;
  }

  return item.csgRemoved ?? undefined;
}

function getCsgUnchangedGeometry(item: DiffItem): BufferGeometry | undefined {
  if (item.status === "unchanged" || !item.geometryChanged) {
    return item.newGeometry ?? item.oldGeometry ?? undefined;
  }

  return item.csgUnchanged ?? undefined;
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
