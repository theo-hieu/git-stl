<template></template>

<script setup lang="ts">
import { useTres } from "@tresjs/core";
import { WebGLRenderer } from "three";
import { onBeforeUnmount, onMounted } from "vue";
import { setThumbnailCaptureHandler } from "../composables/useSceneThumbnail";

const { camera, renderer, scene } = useTres();

function captureThumbnail(): string | null {
  const activeCamera = camera.value;

  if (!activeCamera || !(renderer instanceof WebGLRenderer)) {
    return null;
  }

  const canvas = renderer.domElement;
  renderer.render(scene.value, activeCamera);

  const context = renderer.getContext();
  if (typeof context.finish === "function") {
    context.finish();
  }

  return canvas.toDataURL("image/png");
}

onMounted(() => {
  setThumbnailCaptureHandler(captureThumbnail);
});

onBeforeUnmount(() => {
  setThumbnailCaptureHandler(null);
});
</script>
