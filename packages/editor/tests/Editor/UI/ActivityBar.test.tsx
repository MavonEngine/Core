// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ActivityBar from '../../../src/Editor/UI/ActivityBar'

vi.mock('../../../src/Editor/UI/ActivityBar.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))

afterEach(cleanup)

describe('activityBar', () => {
  it('offers the scene editor, then the server', () => {
    render(<ActivityBar active="scene" onSelect={() => {}} />)

    expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Scene', 'Server'])
  })

  it('marks the active view', () => {
    render(<ActivityBar active="server" onSelect={() => {}} />)

    expect(screen.getByRole('button', { name: 'Server' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Scene' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('asks for the view whose icon is clicked', () => {
    const onSelect = vi.fn()
    render(<ActivityBar active="scene" onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: 'Server' }))
    fireEvent.click(screen.getByRole('button', { name: 'Scene' }))

    expect(onSelect.mock.calls).toEqual([['server'], ['scene']])
  })
})
