import type { Root } from 'react-dom/client'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { registerEditorPanel } from './panels'
import EditorUI from './UI/Editor'
import NetworkPanel from './UI/Network/NetworkPanel'

export function mountEditorUI(container: HTMLElement): Root {
  // Docked like a custom panel, so it only asks the server while its tab is shown. Before the game's own panels
  registerEditorPanel({ id: 'network', title: 'Network', location: 'bottom', order: -1, component: NetworkPanel })

  const root = createRoot(container)
  root.render(createElement(EditorUI))
  return root
}
