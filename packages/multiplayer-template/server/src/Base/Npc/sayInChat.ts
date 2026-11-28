import type { NodeDefinition } from '@mavonengine/core/Graph/NodeRegistry'
import { registerNode } from '@mavonengine/core/Graph/NodeRegistry'

/** Posts a chat line as an entity, by its id. Set by the server: elsewhere the node does nothing */
type ChatPoster = (speakerId: string, message: string) => void
let post: ChatPoster | undefined

/** Where Say in Chat posts. The server sends the line to every player */
export function onSayInChat(poster: ChatPoster) {
  post = poster
}

/**
 * A logic graph node that says something in the game's chat, as the graph's Self (an NPC, say). Registered on both
 * sides: the editor needs to know it to edit graphs using it, the server to run them
 */
export const sayInChatNode: NodeDefinition = {
  type: 'chat.say',
  label: 'Say in Chat',
  category: 'Actions',
  description: 'Post a line in the chat as the graph\'s Self. Only does something in graphs running on the server',
  kinds: ['logic'],
  inputs: {
    run: { type: 'exec', label: '' },
    message: { type: 'any', label: 'Message', default: 'Hello!' },
  },
  outputs: {
    then: { type: 'exec', label: '' },
  },
  run: ({ message }, { self }) => {
    post?.(self?.id ?? '', String(message ?? ''))
  },
}

export function registerChatNodes() {
  registerNode(sayInChatNode)
}
