import { ref } from 'vue'

export interface ChatMessage {
  id: number
  playerName: string
  message: string
  isSystem: boolean
  /** Links in it can be followed: the server or an NPC said it. What players type stays text */
  trusted: boolean
  timestamp: number
}

/** A piece of a chat line: text, or a link to follow */
export interface ChatPart {
  text: string
  href?: string
}

// http(s) URLs. The punctuation ending a sentence around one is trimmed off it
const URL_RE = /https?:\/\/[^\s<>"]+/g
const TRAILING_PUNCTUATION_RE = /[.,!?;:)]+$/

/** A chat line in pieces, its URLs as links */
export function chatParts(message: string): ChatPart[] {
  const parts: ChatPart[] = []
  let at = 0
  for (const match of message.matchAll(URL_RE)) {
    const url = match[0].replace(TRAILING_PUNCTUATION_RE, '')
    if (match.index > at) {
      parts.push({
        text: message.slice(at, match.index),
      })
    }
    parts.push({ text: url, href: url })
    at = match.index + url.length
  }
  if (at < message.length) {
    parts.push({
      text: message.slice(at),
    })
  }
  return parts
}

let idCounter = 0
const chatMessages = ref<ChatMessage[]>([])

function useChat() {
  function addMessage(playerName: string, message: string, isSystem = false, trusted = isSystem) {
    chatMessages.value.push({
      id: idCounter++,
      playerName,
      message,
      isSystem,
      trusted,
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
