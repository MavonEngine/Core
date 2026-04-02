<script setup lang="ts">
import { ref } from 'vue'
import useStore from '../stores/Game'

const RANDOM_NAMES = [
  'AceRider',
  'BlazeFox',
  'CrimsonOwl',
  'DriftKing',
  'EmberWolf',
  'FrostByte',
  'GhostPine',
  'HexStorm',
  'IronClad',
  'JoltSpike',
  'KryptoZen',
  'LunaRift',
  'MidnightAsh',
  'NovaShard',
  'OmegaPulse',
  'PrismFang',
  'QuickSilver',
  'RogueComet',
  'SteelViper',
  'TurboZap',
]

const { store } = useStore()
const nameInput = ref(store.value.playerName || RANDOM_NAMES[Math.floor(Math.random() * RANDOM_NAMES.length)])
const error = ref('')

function join() {
  const trimmed = nameInput.value!.trim()
  if (!trimmed) {
    error.value = 'Please enter a name.'
    return
  }
  store.value.playerName = trimmed
  store.value.inWorld = true
  window.dispatchEvent(new CustomEvent('gameUIReady'))
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter')
    join()
}
</script>

<template>
  <div class="main-menu">
    <div class="card">
      <h1>Multiplayer Template</h1>
      <p class="subtitle">
        Enter a name and jump in.
      </p>
      <input
        v-model="nameInput"
        type="text"
        name="game-handle"
        placeholder="Enter username"
        maxlength="20"
        class="name-input"
        autofocus
        autocomplete="new-password"
        @keydown="onKeydown"
      >
      <p v-if="error" class="error">
        {{ error }}
      </p>
      <button class="join-btn" @click="join">
        Join
      </button>
    </div>
  </div>
</template>

<style scoped>
.main-menu {
  pointer-events: all;
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.65);
}

.card {
  background: rgba(20, 20, 30, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  padding: 40px 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  min-width: 320px;
}

h1 {
  font-size: 24px;
  font-weight: 700;
  color: #fff;
  letter-spacing: 0.5px;
}

.subtitle {
  color: rgba(255, 255, 255, 0.5);
  font-size: 14px;
  margin-top: -8px;
}

.name-input {
  width: 100%;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  color: #fff;
  font-size: 16px;
  padding: 10px 14px;
  outline: none;
  transition: border-color 0.2s;
}

.name-input:focus {
  border-color: #7ef0a0;
}

.error {
  color: #f48fb1;
  font-size: 13px;
}

.join-btn {
  pointer-events: all;
  width: 100%;
  background: #7ef0a0;
  color: #111;
  font-size: 15px;
  font-weight: 700;
  border: none;
  border-radius: 8px;
  padding: 12px;
  cursor: pointer;
  transition: background 0.2s, transform 0.1s;
}

.join-btn:hover {
  background: #9ef5b2;
}

.join-btn:active {
  transform: scale(0.98);
}
</style>
