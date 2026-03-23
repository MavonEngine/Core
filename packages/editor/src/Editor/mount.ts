import type { Root } from 'react-dom/client'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import EditorUI from './UI/Editor'

export function mountEditorUI(container: HTMLElement): Root {
  const root = createRoot(container)
  root.render(createElement(EditorUI))
  return root
}
