// @vitest-environment jsdom
import { EventDispatcher } from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import XR from '../src/XR'

vi.mock('three/examples/jsm/webxr/VRButton.js', () => ({
  VRButton: {
    createButton: vi.fn(() => {
      const button = document.createElement('button')
      button.id = 'VRButton'
      return button
    }),
  },
}))

function setup(options?: ConstructorParameters<typeof XR>[2]) {
  const session = {
    end: vi.fn().mockResolvedValue(undefined),
  }
  const xr = Object.assign(new EventDispatcher<any>(), {
    enabled: false,
    isPresenting: false,
    setReferenceSpaceType: vi.fn(),
    setSession: vi.fn().mockResolvedValue(undefined),
    getSession: vi.fn((): any => null),
  })
  const renderer = {
    instance: { xr },
    get xrPresenting() {
      return xr.isPresenting
    },
  }
  const game = {
    trigger: vi.fn(),
    sizes: {
      setSize: vi.fn(),
    },
  }
  const instance = new XR(renderer as any, game as any, options)
  return { instance, xr, game, session }
}

describe('xr', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('enables the renderer\'s XR with a floor reference space and adds the enter button', () => {
    const { instance, xr } = setup()

    expect(xr.enabled).toBe(true)
    expect(xr.setReferenceSpaceType).toHaveBeenCalledWith('local-floor')
    expect(instance.button).toBeDefined()
    expect(document.getElementById('VRButton')).toBe(instance.button)
  })

  it('leaves the button out and uses the given reference space', () => {
    const { instance, xr } = setup({ button: false, referenceSpace: 'local' })

    expect(xr.setReferenceSpaceType).toHaveBeenCalledWith('local')
    expect(instance.button).toBeUndefined()
    expect(document.getElementById('VRButton')).toBeNull()
  })

  it('triggers session events and catches up with the window size once a session ends', () => {
    const { xr, game, session } = setup()
    xr.getSession.mockReturnValue(session)

    xr.dispatchEvent({ type: 'sessionstart' })
    expect(game.trigger).toHaveBeenCalledWith('xrSessionStart', session)

    xr.dispatchEvent({ type: 'sessionend' })
    expect(game.sizes.setSize).toHaveBeenCalledWith(window.innerWidth, window.innerHeight)
    expect(game.trigger).toHaveBeenCalledWith('xrSessionEnd')
  })

  it('enters an immersive VR session with the floor features and the extra ones asked for', async () => {
    const { instance, xr, session } = setup({
      sessionInit: {
        optionalFeatures: ['hand-tracking'],
      },
    })
    const requestSession = vi.fn().mockResolvedValue(session)
    vi.stubGlobal('navigator', {
      xr: { requestSession },
    })

    await expect(instance.enter()).resolves.toBe(session)
    expect(requestSession).toHaveBeenCalledWith('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
    })
    expect(xr.setSession).toHaveBeenCalledWith(session)

    xr.getSession.mockReturnValue(session)
    await instance.exit()
    expect(session.end).toHaveBeenCalled()
  })

  it('explains why entering fails without WebXR', async () => {
    const { instance } = setup()
    vi.stubGlobal('navigator', {})

    await expect(instance.enter()).rejects.toThrow('secure context')
    await expect(XR.isSupported()).resolves.toBe(false)
  })

  it('reports support from the browser', async () => {
    vi.stubGlobal('navigator', {
      xr: {
        isSessionSupported: vi.fn().mockResolvedValue(true),
      },
    })
    await expect(XR.isSupported()).resolves.toBe(true)
  })
})
