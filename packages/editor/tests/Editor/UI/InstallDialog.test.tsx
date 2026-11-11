// @vitest-environment jsdom

import type { InstallJob } from '../../../src/Editor/Plugins/pluginsApi'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InstallDialog, { INSTALL_POLL_MS, sourceOf } from '../../../src/Editor/UI/Plugins/InstallDialog'

vi.mock('../../../src/Editor/UI/Plugins/InstallDialog.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * The dev server: starts an install on POST and answers GET with whatever `status` says right now,
 * or not at all while it is being restarted.
 */
function devServer(start: () => Response = () => json({ job: job() }, 202)) {
  const server = {
    status: { available: true, job: job() } as object | null,
    posted: [] as unknown[],
    fetch: vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        server.posted.push({ headers: init.headers, body: JSON.parse(String(init.body)) })
        return start()
      }
      if (!server.status)
        throw new TypeError('Failed to fetch')
      return json(server.status)
    }) as unknown as typeof fetch,
  }
  return server
}

function job(overrides: Partial<InstallJob> = {}): InstallJob {
  return { id: 4, packages: ['@acme/weather'], status: 'installing', output: '', ...overrides }
}

const request = { packages: ['@acme/weather'], homepage: 'https://github.com/acme/weather' }

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('installDialog', () => {
  it('says what installing means and where the source is, and installs nothing by itself', () => {
    const server = devServer()
    render(<InstallDialog request={request} onClose={() => {}} fetchFn={server.fetch} />)

    const dialog = screen.getByRole('dialog', { name: 'Install @acme/weather?' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    screen.getByText('Installing a package runs its code on this machine.')
    screen.getByText(/Nothing reviews what is installed from here/)
    screen.getByText('Check the source before you install it:')
    expect(screen.getByText('https://github.com/acme/weather').getAttribute('href')).toBe('https://github.com/acme/weather')
    expect(server.fetch).not.toHaveBeenCalled()
  })

  it('only installs once the source was confirmed to be checked', () => {
    const server = devServer()
    render(<InstallDialog request={request} onClose={() => {}} fetchFn={server.fetch} />)
    const install = screen.getByRole('button', { name: 'Install' }) as HTMLButtonElement

    expect(install.disabled).toBe(true)
    fireEvent.click(install)
    expect(server.posted).toEqual([])

    fireEvent.click(screen.getByLabelText('I have checked the source and trust it'))
    expect(install.disabled).toBe(false)

    // Unticking takes it back
    fireEvent.click(screen.getByLabelText('I have checked the source and trust it'))
    expect(install.disabled).toBe(true)
  })

  it('cancels without installing', () => {
    const server = devServer()
    const onClose = vi.fn()
    render(<InstallDialog request={request} onClose={onClose} fetchFn={server.fetch} />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(server.fetch).not.toHaveBeenCalled()
  })

  it('installs, shows the output, waits out the restart and offers to reload', async () => {
    vi.useFakeTimers()
    const server = devServer()
    render(<InstallDialog request={request} onClose={() => {}} fetchFn={server.fetch} />)

    fireEvent.click(screen.getByLabelText('I have checked the source and trust it'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Install' })))

    expect(server.posted).toEqual([{ headers: { 'Content-Type': 'application/json' }, body: { packages: ['@acme/weather'] } }])
    screen.getByRole('dialog', { name: 'Installing @acme/weather' })
    screen.getByText('Running the package manager…')
    // Nothing to click while it runs
    expect(screen.queryByRole('button')).toBeNull()

    server.status = { available: true, job: job({ output: 'added 3 packages in 2s\n' }) }
    await act(() => vi.advanceTimersByTimeAsync(INSTALL_POLL_MS))
    screen.getByText(/added 3 packages in 2s/)

    server.status = { available: true, job: job({ status: 'restarting', output: 'added 3 packages in 2s\n' }) }
    await act(() => vi.advanceTimersByTimeAsync(INSTALL_POLL_MS))
    screen.getByRole('dialog', { name: 'Installed @acme/weather, restarting' })

    // The dev server itself is down for a moment
    server.status = null
    await act(() => vi.advanceTimersByTimeAsync(INSTALL_POLL_MS))
    screen.getByText('The dev servers are restarting. The editor reloads when they are back.')
    screen.getByText(/added 3 packages in 2s/)

    server.status = { available: true, job: job({ status: 'done', output: 'added 3 packages in 2s\n' }) }
    await act(() => vi.advanceTimersByTimeAsync(INSTALL_POLL_MS))
    screen.getByRole('dialog', { name: 'Installed @acme/weather' })
    screen.getByRole('button', { name: 'Reload the editor' })
    screen.getByRole('button', { name: 'Close' })
  })

  it('says why an install failed, with what the package manager wrote', async () => {
    vi.useFakeTimers()
    const server = devServer()
    render(<InstallDialog request={request} onClose={() => {}} fetchFn={server.fetch} />)
    fireEvent.click(screen.getByLabelText('I have checked the source and trust it'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Install' })))

    server.status = { available: true, job: job({ status: 'failed', output: 'npm error 404 Not Found\n', error: '\'npm install @acme/weather\' exited with code 1' }) }
    await act(() => vi.advanceTimersByTimeAsync(INSTALL_POLL_MS))

    screen.getByRole('dialog', { name: 'Could not install @acme/weather' })
    expect(screen.getByRole('alert').textContent).toBe('\'npm install @acme/weather\' exited with code 1')
    screen.getByText(/404 Not Found/)
    expect(screen.queryByRole('button', { name: 'Reload the editor' })).toBeNull()
  })

  it('says so when the install can\'t be started', async () => {
    const server = devServer(() => json({ error: 'Start the project with `mavonengine dev` to install packages from here' }, 409))
    render(<InstallDialog request={request} onClose={() => {}} fetchFn={server.fetch} />)
    fireEvent.click(screen.getByLabelText('I have checked the source and trust it'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Install' })))

    expect(screen.getByRole('alert').textContent).toContain('mavonengine dev')
    screen.getByRole('button', { name: 'Close' })
  })

  it('points at where each package can be looked at', () => {
    expect(sourceOf('forest')).toBe('https://www.npmjs.com/package/forest')
    expect(sourceOf('@acme/forest@1.2.0')).toBe('https://www.npmjs.com/package/@acme/forest')
    expect(sourceOf('forest', 'https://example.com/forest')).toBe('https://example.com/forest')
    expect(sourceOf('https://example.com/forest.tgz')).toBe('https://example.com/forest.tgz')
    // Only the web is linked to
    expect(sourceOf('forest', 'javascript:alert(1)')).toBe('https://www.npmjs.com/package/forest')
    expect(sourceOf('file:../forest')).toBeUndefined()
    expect(sourceOf('./forest')).toBeUndefined()
    expect(sourceOf('github:acme/forest')).toBeUndefined()

    render(<InstallDialog request={{ packages: ['forest', 'file:../mine'] }} onClose={() => {}} />)
    screen.getByRole('dialog', { name: 'Install forest, file:../mine?' })
    screen.getByText('https://www.npmjs.com/package/forest')
    screen.getByText('No page to link to: look at what it points to yourself')
  })
})
