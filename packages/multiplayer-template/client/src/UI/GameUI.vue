<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import useChat from './composables/useChat'
import useNetworkState from './composables/useNetworkState'
import NetworkManager from '../NetworkManager'
import { ENGINE_VERSION } from '@mavonengine/core/BaseGame'

const { chatMessages } = useChat()
const { networkState } = useNetworkState()

const chatInput = ref('')
const messagesEl = ref<HTMLDivElement | null>(null)
const inputFocused = ref(false)

watch(chatMessages, async () => {
  await nextTick()
  if (messagesEl.value) {
    messagesEl.value.scrollTop = messagesEl.value.scrollHeight
  }
}, { deep: true })

function sendChat() {
  const msg = chatInput.value.trim()
  if (!msg) return
  (NetworkManager.getInstance() as NetworkManager)?.sendChat(msg)
  chatInput.value = ''
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') sendChat()
  // Prevent game from receiving keystrokes while typing
  e.stopPropagation()
}
</script>

<template>
  <div class="game-ui">
    <!-- HUD top-left -->
    <div class="hud">
      <span :class="['status-dot', networkState.connected ? 'online' : 'offline']" />
      <span class="hud-text">
        {{ networkState.connected ? `${networkState.players + 1} online · ${networkState.ping}ms` : 'Connecting…' }}
      </span>
      <span class="hud-links">
        <span class="hud-version">MavonEngine v{{ ENGINE_VERSION }}</span>
        <a href="https://mavonengine.com/getting-started" target="_blank" rel="noopener">Docs</a>
        <a href="https://mavonengine.com/community" target="_blank" rel="noopener">Community</a>
      </span>
    </div>

    <!-- Chat panel -->
    <div class="chat-panel" :class="{ focused: inputFocused }">
      <div ref="messagesEl" class="messages">
        <div
          v-for="msg in chatMessages"
          :key="msg.id"
          :class="['msg', msg.isSystem ? 'system' : '']"
        >
          <span v-if="!msg.isSystem" class="msg-name">{{ msg.playerName }}</span>
          <span class="msg-text">{{ msg.isSystem ? msg.message : `: ${msg.message}` }}</span>
        </div>
      </div>
      <div class="chat-input-row">
        <input
          v-model="chatInput"
          class="chat-input"
          placeholder="Press Enter to chat…"
          maxlength="120"
          @keydown="onKeydown"
          @focus="inputFocused = true"
          @blur="inputFocused = false"
        />
        <button class="send-btn" @click="sendChat">↵</button>
      </div>
    </div>

    <!-- Controls hint -->
    <div class="controls-hint">WASD · move</div>
  </div>
</template>

<style scoped>
.game-ui {
  pointer-events: none;
  width: 100%;
  height: 100%;
  position: relative;
}

/* HUD */
.hud {
  position: absolute;
  top: 16px;
  left: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(0, 0, 0, 0.5);
  padding: 6px 12px;
  border-radius: 20px;
  color: #fff;
  font-size: 13px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.status-dot.online { background: #7ef0a0; }
.status-dot.offline { background: #f48fb1; }

.hud-links {
  display: flex;
  gap: 8px;
  pointer-events: all;
}

.hud-version {
  color: rgba(255, 255, 255, 0.4);
  font-size: 12px;
}

.hud-links a {
  color: rgba(255, 255, 255, 0.6);
  font-size: 12px;
  text-decoration: none;
  transition: color 0.2s;
}

.hud-links a:hover {
  color: #fff;
}

/* Chat panel */
.chat-panel {
  pointer-events: all;
  position: absolute;
  bottom: 16px;
  left: 16px;
  width: 320px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.messages {
  max-height: 180px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255,255,255,0.2) transparent;
}

.msg {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.9);
  background: rgba(0, 0, 0, 0.55);
  padding: 3px 8px;
  border-radius: 4px;
  line-height: 1.4;
}

.msg.system {
  color: rgba(255, 255, 255, 0.5);
  font-style: italic;
}

.msg-name {
  font-weight: 600;
  color: #7ef0a0;
}

.chat-input-row {
  display: flex;
  gap: 4px;
}

.chat-input {
  flex: 1;
  background: rgba(0, 0, 0, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  color: #fff;
  font-size: 13px;
  padding: 7px 10px;
  outline: none;
  transition: border-color 0.2s;
}

.chat-input:focus {
  border-color: rgba(126, 240, 160, 0.6);
}

.send-btn {
  background: rgba(126, 240, 160, 0.15);
  border: 1px solid rgba(126, 240, 160, 0.3);
  border-radius: 6px;
  color: #7ef0a0;
  font-size: 16px;
  padding: 0 10px;
  cursor: pointer;
  transition: background 0.2s;
}

.send-btn:hover {
  background: rgba(126, 240, 160, 0.25);
}

/* Controls hint */
.controls-hint {
  position: absolute;
  bottom: 16px;
  right: 16px;
  color: rgba(255, 255, 255, 0.3);
  font-size: 12px;
}
</style>
