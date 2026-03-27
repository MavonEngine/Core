import { ref } from 'vue'

export interface ChatMessage {
  id: number
  playerName: string
  message: string
  isSystem: boolean
  timestamp: number
}

let idCounter = 0
const chatMessages = ref<ChatMessage[]>([])

function useChat() {
  function addMessage(playerName: string, message: string, isSystem = false) {
    chatMessages.value.push({
      id: idCounter++,
      playerName,
      message,
      isSystem,
      timestamp: Date.now(),
    })

    // Keep last 100 messages
    if (chatMessages.value.length > 100) {
      chatMessages.value.shift()
    }
  }

  return { chatMessages, addMessage }
}

export default useChat
