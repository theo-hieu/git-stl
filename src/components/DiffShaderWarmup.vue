<template></template>

<script setup lang="ts">
import { useTresContext } from "@tresjs/core";
import {
  BoxGeometry,
  Mesh,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from "three";
import { onBeforeUnmount, onMounted, watch } from "vue";
import { useGitDiff } from "../composables/useGitDiff";
import { diffGreenMaterial, diffRedMaterial } from "../materials/diffMaterials";

const { renderer } = useTresContext();
const { isDiffMode } = useGitDiff();

let hasPrecompiledDiffShaders = false;
let pendingWarmupFrame: number | null = null;

function cancelWarmupFrame(): void {
  if (pendingWarmupFrame === null) {
    return;
  }

  cancelAnimationFrame(pendingWarmupFrame);
  pendingWarmupFrame = null;
}

function precompileShaders(webglRenderer: WebGLRenderer): void {
  if (hasPrecompiledDiffShaders) {
    return;
  }

  const dummyScene = new Scene();
  const dummyCamera = new PerspectiveCamera(50, 1, 0.1, 10);
  const dummyGeometry = new BoxGeometry(0.01, 0.01, 0.01);
  const redMesh = new Mesh(dummyGeometry, diffRedMaterial);
  const greenMesh = new Mesh(dummyGeometry, diffGreenMaterial);

  redMesh.position.x = -0.02;
  greenMesh.position.x = 0.02;
  dummyCamera.position.z = 1;
  dummyScene.add(redMesh, greenMesh);

  try {
    webglRenderer.compile(dummyScene, dummyCamera);
    hasPrecompiledDiffShaders = true;
  } finally {
    dummyScene.remove(redMesh, greenMesh);
    dummyGeometry.dispose();
  }
}

function scheduleShaderWarmup(): void {
  if (hasPrecompiledDiffShaders) {
    return;
  }

  const webglRenderer = renderer.instance;
  if (!(webglRenderer instanceof WebGLRenderer)) {
    return;
  }

  cancelWarmupFrame();
  pendingWarmupFrame = requestAnimationFrame(() => {
    pendingWarmupFrame = null;
    precompileShaders(webglRenderer);
  });
}

onMounted(() => {
  scheduleShaderWarmup();
});

watch(isDiffMode, (enabled) => {
  if (enabled) {
    scheduleShaderWarmup();
  }
});

onBeforeUnmount(() => {
  cancelWarmupFrame();
});
</script>
