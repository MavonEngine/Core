<script setup lang="ts">
import useStore from '../stores/Game'
import GameUI from './GameUI.vue'
import MainMenu from './MainMenu.vue'

const { store } = useStore()
</script>

<template>
  <div id="ui-frame">
    <GameUI v-if="store.inWorld" />
    <MainMenu v-else />
  </div>
  <div id="loadingBar" class="loadingBar" />
</template>

<style scoped>
#ui-frame {
  user-select: none;
  font-family: 'Segoe UI', system-ui, sans-serif;
  position: absolute;
  top: 0;
  left: 0;
  color: white;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
</style>
