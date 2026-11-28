// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InspectorPanel from '../../../src/Editor/UI/Inspector/InspectorPanel'

vi.mock('../../../src/Editor/UI/Inspector/InspectorPanel.module.css', () => ({
  default: { root: 'root' },
}))

const renderer = vi.hoisted(() => ({
  inspector: undefined as unknown,
  attachInspector: vi.fn(),
  detachInspector: vi.fn(),
}))

vi.mock('@mavonengine/core/Game', () => ({
  default: {
    instance: () => ({ renderer }),
  },
}))

function fakeInspector() {
  const panel = document.createElement('div')
  return {
    domElement: document.createElement('div'),
    profiler: {
      panel,
      setPosition: vi.fn(),
      togglePanel: vi.fn(() => panel.classList.toggle('visible')),
    },
  }
}

describe('inspectorPanel', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('runs the inspector in the panel while it is shown, opened in the bottom layout', () => {
    const inspector = fakeInspector()
    renderer.attachInspector.mockImplementation((container: HTMLElement) => {
      container.appendChild(inspector.domElement)
      renderer.inspector = inspector
      return inspector
    })

    const { container, unmount } = render(<InspectorPanel />)

    const root = container.querySelector('.root')!
    expect(renderer.attachInspector).toHaveBeenCalledWith(root)
    expect(root.contains(inspector.domElement)).toBe(true)
    expect(inspector.profiler.setPosition).toHaveBeenCalledWith('bottom')
    expect(inspector.profiler.panel.classList.contains('visible')).toBe(true)

    unmount()
    expect(renderer.detachInspector).toHaveBeenCalledTimes(1)
  })

  it('leaves an inspector started elsewhere since running', () => {
    const inspector = fakeInspector()
    inspector.profiler.panel.classList.add('visible')
    renderer.attachInspector.mockImplementation(() => {
      renderer.inspector = inspector
      return inspector
    })

    const { unmount } = render(<InspectorPanel />)
    // Already open: not toggled shut
    expect(inspector.profiler.togglePanel).not.toHaveBeenCalled()

    renderer.inspector = fakeInspector()
    unmount()
    expect(renderer.detachInspector).not.toHaveBeenCalled()
  })
})
