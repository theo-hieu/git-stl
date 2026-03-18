<template>
  <div class="scene-container">
    <TresCanvas clear-color="#0f172a" style="width: 100%; height: 100%;">
      <TresPerspectiveCamera :position="cameraPosition" />
      <OrbitControls :target="controlsTarget" />
      <TresDirectionalLight :position="[5, 5, 5]" :intensity="1" />
      <TresAmbientLight :intensity="0.5" />

      <!-- Render every part in the multi-part assembly -->
      <TresMesh v-for="(item, idx) in assembly" :key="idx" :geometry="item.geometry" :position="item.position"
        :rotation="item.rotation" :visible="item.visible">
        <TresMeshStandardMaterial color="#3b82f6" :wireframe="isWireframe" />
      </TresMesh>

      <!-- Placeholder when nothing is loaded -->
      <AnimatedBox v-if="assembly.length === 0" />
    </TresCanvas>
  </div>
</template>

<script setup lang="ts">
import { OrbitControls } from '@tresjs/cientos';
import AnimatedBox from './AnimatedBox.vue';
import { assembly, isWireframe, cameraPosition, controlsTarget } from '../store';
</script>

<style scoped>
.scene-container {
  flex-grow: 1;
  position: relative;
  height: 100vh;
}
</style>
