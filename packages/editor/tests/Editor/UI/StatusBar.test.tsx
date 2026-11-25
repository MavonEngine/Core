// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StatusBar from '../../../src/Editor/UI/StatusBar'

vi.mock('../../../src/Editor/UI/StatusBar.module.css', () => ({
  default: new Proxy({}, {
    get: (_, key) => String(key),
  }),
}))
vi.mock('../../../src/Editor/UI/useSceneStats', () => ({
  useSceneStats: () => ({
    fps: 60,
    triangles: 0,
    drawCalls: 0,
    objects: 0,
    materials: 0,
    textures: 0,
  }),
}))
vi.mock('../../../src/Editor/UI/Controllers/useGamepads', () => ({
  useGamepads: () => [],
}))

beforeEach(() => {
  vi.useFakeTimers()
  ;(window as any).Game = {
    network: { connected: false, connectError: null },
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('statusBar', () => {
  it('warns while the server turns the tab away, and stops once it connects', async () => {
    render(<StatusBar />)
    expect(screen.queryByRole('status')).toBeNull()

    ;(window as any).Game.network.connectError = { message: 'Connection failed with status code 401.', status: 401 }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    const warning = screen.getByRole('status')
    expect(warning.textContent).toBe('⚠ Server refused (401)')
    expect(warning.getAttribute('title')).toMatch(/log in to the game first/)

    Object.assign((window as any).Game.network, { connected: true, connectError: null })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(screen.queryByRole('status')).toBeNull()
  })
})
