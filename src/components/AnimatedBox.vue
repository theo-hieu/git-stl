<template>
  <TresMesh ref="boxRef" :position="[0, 0, 0]">
    <TresBoxGeometry :args="[2, 2, 2]" />
    <TresMeshNormalMaterial />
  </TresMesh>
</template>

<script setup lang="ts">
import { shallowRef } from 'vue';
import { useLoop } from '@tresjs/core';

// Using shallowRef instead of ref for Three.js objects for better performance
// as recommended by TresJS
const boxRef = shallowRef();

const { onBeforeRender } = useLoop();

onBeforeRender(({ delta }) => {
  if (boxRef.value) {
    boxRef.value.rotation.y += delta;
    boxRef.value.rotation.x += delta * 0.5;
  }
});
</script>
