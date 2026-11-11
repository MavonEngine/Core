import { DEV_CONTROL_TOKEN_HEADER } from '@mavonengine/core/Plugins/install'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startDevControl } from '../src/dev/control'
import PluginInstaller, { InstallRefused, MAX_INSTALL_OUTPUT } from '../src/dev/installer'

/** Lets a test decide when the package manager is done */
function deferred() {
  let finish!: (code: number) => void
  const promise = new Promise<number>(resolve => finish = resolve)
  return { promise, finish }
}

describe('pluginInstaller', () => {
  it('installs the packages, then restarts the dev script', async () => {
    const order: string[] = []
    const installer = new PluginInstaller({
      root: '/project',
      install: async (root, packages, write) => {
        order.push(`install ${packages.join(' ')} in ${root}`)
        write('added 2 packages\n')
        return 0
      },
      restart: async () => void order.push('restart'),
    })
    const statuses: string[] = []
    installer.onChange(job => statuses.push(job.status))

    const job = installer.start(['@acme/weather', 'forest'])
    expect(job).toMatchObject({ id: 1, packages: ['@acme/weather', 'forest'], status: 'installing' })
    expect(installer.busy).toBe(true)

    await installer.finished

    expect(order).toEqual(['install @acme/weather forest in /project', 'restart'])
    expect(installer.job!.status).toBe('done')
    expect(installer.job!.error).toBeUndefined()
    expect(installer.job!.output).toContain('added 2 packages')
    expect(installer.job!.output).toContain('restarting the dev script')
    expect(installer.busy).toBe(false)
    expect([...new Set(statuses)]).toEqual(['installing', 'restarting', 'done'])
  })

  it('does not restart when the install fails, and says why', async () => {
    const restart = vi.fn(async () => {})
    const installer = new PluginInstaller({
      root: '/project',
      restart,
      install: async (_root, _packages, write) => {
        write('npm error 404 Not Found\n')
        throw new Error('\'npm install nope\' exited with code 1')
      },
    })

    installer.start(['nope'])
    await installer.finished

    expect(installer.job).toMatchObject({ status: 'failed', error: '\'npm install nope\' exited with code 1' })
    expect(installer.job!.output).toContain('404 Not Found')
    expect(restart).not.toHaveBeenCalled()

    // A plugin among them that could not be set up counts as failed too
    const partly = new PluginInstaller({ root: '/project', restart, install: async () => 1 })
    partly.start(['forest'])
    await partly.finished
    expect(partly.job!.status).toBe('failed')
    expect(restart).not.toHaveBeenCalled()
  })

  it('runs one install at a time', async () => {
    const pm = deferred()
    const installer = new PluginInstaller({ root: '/project', restart: async () => {}, install: () => pm.promise })

    installer.start(['forest'])
    expect(() => installer.start(['chat'])).toThrow(InstallRefused)
    expect(() => installer.start(['chat'])).toThrow('Still installing forest')

    pm.finish(0)
    await installer.finished

    expect(installer.start(['chat']).id).toBe(2)
    await installer.finished
  })

  it('refuses what is no package before running anything', () => {
    const install = vi.fn(async () => 0)
    const installer = new PluginInstaller({ root: '/project', restart: async () => {}, install })

    expect(() => installer.start(['forest; rm -rf ~'])).toThrow(InstallRefused)
    expect(() => installer.start(['--global'])).toThrow('not something that can be installed')
    expect(() => installer.start([])).toThrow(InstallRefused)
    expect(install).not.toHaveBeenCalled()
    expect(installer.job).toBeNull()
  })

  it('keeps only the end of a long output', async () => {
    const installer = new PluginInstaller({
      root: '/project',
      restart: async () => {},
      install: async (_root, _packages, write) => {
        write('x'.repeat(MAX_INSTALL_OUTPUT))
        write('the end')
        return 0
      },
    })

    installer.start(['forest'])
    await installer.finished

    expect(installer.job!.output.length).toBeLessThanOrEqual(MAX_INSTALL_OUTPUT)
    expect(installer.job!.output).toContain('the end')
  })
})

describe('dev control server', () => {
  let close: (() => Promise<void>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  async function control(installer: PluginInstaller) {
    const started = await startDevControl(installer)
    close = started.close
    const request = (path: string, init: RequestInit = {}, token = started.token) =>
      fetch(`${started.url}${path}`, { ...init, headers: { [DEV_CONTROL_TOKEN_HEADER]: token, ...init.headers } })
    return { ...started, request }
  }

  it('tells the dev script where it is and what to say', async () => {
    const { url, token, env } = await control(new PluginInstaller({ root: '/project', restart: async () => {}, install: async () => 0 }))

    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(token).toMatch(/^[0-9a-f]{48}$/)
    expect(env).toEqual({ MAVONENGINE_DEV_CONTROL_URL: url, MAVONENGINE_DEV_CONTROL_TOKEN: token })
  })

  it('starts an install and reports how it goes', async () => {
    const pm = deferred()
    const restart = vi.fn(async () => {})
    const installer = new PluginInstaller({ root: '/project', restart, install: () => pm.promise })
    const { request } = await control(installer)

    expect(await (await request('/status')).json()).toEqual({ job: null })

    const started = await request('/install', { method: 'POST', body: JSON.stringify({ packages: ['forest'] }) })
    expect(started.status).toBe(202)
    expect(await started.json()).toEqual({ job: { id: 1, packages: ['forest'], status: 'installing', output: '' } })

    // Still running
    const again = await request('/install', { method: 'POST', body: JSON.stringify({ packages: ['chat'] }) })
    expect(again.status).toBe(409)

    pm.finish(0)
    await installer.finished

    expect(await (await request('/status')).json()).toMatchObject({ job: { id: 1, status: 'done' } })
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('wants the token for everything', async () => {
    const install = vi.fn(async () => 0)
    const { request, url } = await control(new PluginInstaller({ root: '/project', restart: async () => {}, install }))

    expect((await request('/status', {}, 'wrong')).status).toBe(401)
    expect((await fetch(`${url}/status`)).status).toBe(401)
    expect((await request('/install', { method: 'POST', body: JSON.stringify({ packages: ['forest'] }) }, '')).status).toBe(401)
    expect(install).not.toHaveBeenCalled()
  })

  it('refuses bad requests', async () => {
    const install = vi.fn(async () => 0)
    const { request } = await control(new PluginInstaller({ root: '/project', restart: async () => {}, install }))

    expect((await request('/install', { method: 'POST', body: 'not json' })).status).toBe(400)
    expect((await request('/install', { method: 'POST', body: JSON.stringify({ packages: ['a; b'] }) })).status).toBe(400)
    expect((await request('/nothing')).status).toBe(404)
    expect(install).not.toHaveBeenCalled()
  })
})
