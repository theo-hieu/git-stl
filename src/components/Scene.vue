<template>
  <div class="scene-container">
    <TresCanvas clear-color="#0f172a" style="width: 100%; height: 100%;">
      <TresPerspectiveCamera :position="[5, 5, 5]" :look-at="[0, 0, 0]" />
      <OrbitControls />
      <TresDirectionalLight :position="[5, 5, 5]" :intensity="1" />
      <TresAmbientLight :intensity="0.5" />

      <TresMesh v-if="activeMeshGeometry" :geometry="activeMeshGeometry">
        <TresMeshStandardMaterial color="#3b82f6" :wireframe="isWireframe" />
      </TresMesh>
      <AnimatedBox v-else />
    </TresCanvas>
  </div>
</template>

<script setup lang="ts">
import { OrbitControls } from '@tresjs/cientos';
import AnimatedBox from './AnimatedBox.vue';
import { activeMeshGeometry, isWireframe } from '../store';
</script>

<style scoped>
.scene-container {
  flex-grow: 1;
  position: relative;
  height: 100vh;
}
</style>
