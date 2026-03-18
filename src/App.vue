<template>
  <div class="app-layout">
    <Sidebar />
    <Scene />
  </div>
</template>

<script setup lang="ts">
import Sidebar from "./components/Sidebar.vue";
import Scene from "./components/Scene.vue";
</script>

<style>
.app-layout {
  display: flex;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
}
</style>