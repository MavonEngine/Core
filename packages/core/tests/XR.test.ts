// @vitest-environment jsdom
import { EventDispatcher, Group, Matrix4, PerspectiveCamera, Scene, Vector4, WebGLRenderTarget } from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import XR, { reverseDepthMatrix } from '../src/XR'

vi.mock('three/examples/jsm/webxr/VRButton.js', () => ({
  VRButton: {
    createButton: vi.fn(() => {
      const button = document.createElement('button')
      button.id = 'VRButton'
      return button
    }),
  },
}))

vi.mock('../src/XRLocomotion', () => ({
  default: vi.fn(function () {
    return {
      update: vi.fn(),
    }
  }),
}))

vi.mock('../src/XRPointer', () => ({
  default: vi.fn(function () {
    return {
      update: vi.fn(),
      dispose: vi.fn(),
    }
  }),
}))

vi.mock('../src/XRInput', () => ({
  default: vi.fn(function () {
    return {
      poll: vi.fn(),
    }
  }),
}))

function setup(options?: ConstructorParameters<typeof XR>[2]) {
  const session = {
    end: vi.fn().mockResolvedValue(undefined),
  }
  const eyes = [
    new PerspectiveCamera(),
    new PerspectiveCamera(),
  ]
  const xr = Object.assign(new EventDispatcher<any>(), {
    enabled: false,
    isPresenting: false,
    setReferenceSpaceType: vi.fn(),
    setSession: vi.fn().mockResolvedValue(undefined),
    getSession: vi.fn((): any => null),
    updateCamera: vi.fn(),
    getCamera: () => ({ cameras: eyes }),
    getFrame: vi.fn((): any => ({})),
  })
  const depth = { reversed: false }
  const draw = vi.fn()
  const renderTarget = { current: null as WebGLRenderTarget | null }
  const webgl = {
    xr,
    shadowMap: { autoUpdate: true },
    getRenderTarget: vi.fn(() => renderTarget.current),
    setRenderTarget: vi.fn((target: WebGLRenderTarget | null) => renderTarget.current = target),
    state: {
      buffers: {
        depth: {
          getReversed: () => depth.reversed,
        },
      },
    },
    render: draw,
  }
  const renderer = {
    instance: webgl,
    get xrPresenting() {
      return xr.isPresenting
    },
  }
  const game = {
    trigger: vi.fn(),
    camera: {
      rig: new Group(),
      instance: new PerspectiveCamera(35, 2, 0.1, 500),
    },
    scene: new Scene(),
    callbacks: {} as Record<string, ((event?: any) => void)[]>,
    on(name: string, callback: (event?: any) => void) {
      (this.callbacks[name] ??= []).push(callback)
    },
    input: {} as Record<string, unknown>,
    sizes: {
      width: 1600,
      height: 900,
      setSize: vi.fn(),
    },
  }
  const instance = new XR(renderer as any, game as any, options)
  return {
    instance,
    xr,
    game,
    session,
    // with the mock render, which XR wraps
    webgl: { ...webgl, render: draw },
    // with XR's wrapped render
    patched: webgl,
    renderTarget,
    depth,
    eyes,
  }
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

  it('sets up the controllers as game.input.xr, unless left out', () => {
    const { instance, game } = setup()
    expect(instance.input).toBeDefined()
    expect(game.input.xr).toBe(instance.input)

    const without = setup({ input: false })
    expect(without.instance.input).toBeUndefined()
    expect(without.game.input.xr).toBeUndefined()
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

    game.camera.rig.position.set(3, 0, 4)
    game.camera.rig.rotation.y = 1
    xr.dispatchEvent({ type: 'sessionend' })
    expect(game.camera.rig.position.toArray()).toEqual([0, 0, 0])
    expect(game.camera.rig.quaternion.toArray()).toEqual([0, 0, 0, 1])
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

  it('runs locomotion every rendered frame, only while in VR', () => {
    const { instance, game, xr } = setup()
    const locomotion = instance.enableLocomotion()
    expect(instance.enableLocomotion()).toBe(locomotion)
    // after the panels' own
    expect(game.callbacks.beforeRender).toHaveLength(2)
    const frame = game.callbacks.beforeRender[1]

    frame(0.016)
    expect(locomotion.update).not.toHaveBeenCalled()

    xr.isPresenting = true
    frame(0.016)
    expect(locomotion.update).toHaveBeenCalledWith(0.016)
  })

  it('puts panels in the camera rig and updates them every rendered frame, pointing at them only in VR', () => {
    const { instance, game, xr } = setup()
    const panel = {
      mesh: new Group(),
      update: vi.fn(),
    }
    expect(instance.addPanel(panel as any)).toBe(panel)
    expect(panel.mesh.parent).toBe(game.camera.rig)
    const frame = game.callbacks.beforeRender[0]

    frame(0.016)
    expect(panel.update).toHaveBeenLastCalledWith(game.camera.instance, false, 0.016)
    expect(instance.pointer!.update).not.toHaveBeenCalled()

    xr.isPresenting = true
    frame(0.02)
    expect(panel.update).toHaveBeenLastCalledWith(game.camera.instance, true, 0.02)
    expect(instance.pointer!.update).toHaveBeenCalledTimes(1)

    instance.removePanel(panel as any)
    expect(panel.mesh.parent).toBeNull()
    expect(instance.panels.size).toBe(0)
  })

  it('needs the controllers for locomotion', () => {
    const { instance } = setup({ input: false })
    expect(() => instance.enableLocomotion()).toThrow('input: false')
  })

  it('gives the camera its own field of view back after the session', () => {
    const { xr, game } = setup()
    xr.dispatchEvent({ type: 'sessionstart' })
    // three.js copies the headset's projection onto the camera
    game.camera.instance.fov = 104
    xr.dispatchEvent({ type: 'sessionend' })

    expect(game.camera.instance.fov).toBe(35)
  })

  it('leaves the mirror off unless asked for', () => {
    expect(setup().instance.mirror).toBe(false)
    expect(setup({ mirror: true }).instance.mirror).toBe(true)
    expect(setup({
      mirror: { fov: 90 },
    }).instance.mirrorCamera.fov).toBe(90)
  })

  it('mirrors the headset to the page from the head, shaped like the window, without touching the headset', () => {
    const { instance, game, webgl, renderTarget } = setup({ mirror: true })
    const headsetTarget = new WebGLRenderTarget(1, 1)
    renderTarget.current = headsetTarget
    // Where the headset's frame put the camera, in the rig like the real one
    game.camera.rig.add(game.camera.instance)
    game.camera.rig.position.set(10, 0, 0)
    game.camera.instance.position.set(0, 1.7, 0)
    game.camera.instance.rotation.set(0, Math.PI / 2, 0)
    game.camera.rig.updateMatrixWorld(true)

    let during: { xr: boolean, shadows: boolean, target: unknown } | undefined
    webgl.render.mockImplementation(() => {
      during = { xr: webgl.xr.enabled, shadows: webgl.shadowMap.autoUpdate, target: renderTarget.current }
    })
    webgl.xr.enabled = true
    instance.renderMirror()

    const [scene, camera] = webgl.render.mock.calls[0]
    expect(scene).toBe(game.scene)
    expect(camera).toBe(instance.mirrorCamera)
    expect(camera.position.toArray().map((n: number) => +n.toFixed(6))).toEqual([10, 1.7, 0])
    expect(camera.getWorldDirection(new Group().position).x).toBeCloseTo(-1)
    expect(camera.aspect).toBeCloseTo(1600 / 900)
    expect(camera.far).toBe(500)

    // Drawn to the page with XR off and the headset's shadow maps, then everything put back
    expect(during).toEqual({ xr: false, shadows: false, target: null })
    expect(webgl.xr.enabled).toBe(true)
    expect(webgl.shadowMap.autoUpdate).toBe(true)
    expect(renderTarget.current).toBe(headsetTarget)
  })

  it('puts XR back on even when the mirror\'s render throws', () => {
    const { instance, webgl } = setup({ mirror: true })
    webgl.xr.enabled = true
    webgl.render.mockImplementation(() => {
      throw new Error('lost context')
    })

    expect(() => instance.renderMirror()).toThrow('lost context')
    expect(webgl.xr.enabled).toBe(true)
  })

  describe('renderer fixes', () => {
    it('renders into a render target with the camera it\'s given while presenting, into the headset\'s through it', () => {
      const { xr, webgl, patched, renderTarget } = setup()
      xr.isPresenting = true
      const during: boolean[] = []
      webgl.render.mockImplementation(() => during.push(xr.enabled))

      renderTarget.current = new WebGLRenderTarget(1, 1)
      patched.render(new Scene(), new PerspectiveCamera())
      renderTarget.current = Object.assign(new WebGLRenderTarget(1, 1), { isXRRenderTarget: true })
      patched.render(new Scene(), new PerspectiveCamera())

      expect(during).toEqual([false, true])
      expect(xr.enabled).toBe(true)
    })

    it('gives the eyes and the camera the reversed form of the headset\'s projection with a reversed depth buffer', () => {
      const { xr, depth, eyes } = setup()
      depth.reversed = true
      const gl = new Matrix4().makePerspective(-0.1, 0.1, 0.1, -0.1, 0.1, 100)
      const camera = new PerspectiveCamera()
      for (const c of [...eyes, camera])
        c.projectionMatrix.copy(gl)

      xr.updateCamera(camera)

      for (const c of [...eyes, camera]) {
        expect(c.reversedDepth).toBe(true)
        expect(c.projectionMatrix.equals(reverseDepthMatrix(gl.clone()))).toBe(true)
      }
    })

    it('takes the headset\'s projection with the planes swapped, once a frame, and tells the session depth is reversed', () => {
      const { xr, depth, eyes } = setup()
      depth.reversed = true
      const session = {
        updateRenderState: vi.fn(),
      }
      xr.getSession.mockReturnValue(session)
      const frame = {}
      xr.getFrame.mockReturnValue(frame)
      const camera = new PerspectiveCamera(50, 1, 0.1, 100)
      // what the headset gives with depthNear 100 and depthFar 0.1: the near plane at +1
      const swapped = new Matrix4().makePerspective(-0.1, 0.1, 0.1, -0.1, 0.1, 100)
      const [near, far] = [100, 0.1]
      swapped.elements[10] = -(far + near) / (far - near)
      swapped.elements[14] = -2 * far * near / (far - near)
      const expected = reverseDepthMatrix(new Matrix4().makePerspective(-0.1, 0.1, 0.1, -0.1, 0.1, 100))
      for (const eye of eyes)
        eye.projectionMatrix.copy(swapped)

      xr.updateCamera(camera)
      xr.updateCamera(camera)

      for (const eye of eyes) {
        eye.projectionMatrix.elements.forEach((v, i) => expect(v).toBeCloseTo(expected.elements[i]))
      }
      expect(session.updateRenderState).toHaveBeenCalledTimes(1)
      expect(session.updateRenderState).toHaveBeenCalledWith({ depthNear: 100, depthFar: 0.1 })
    })

    it('leaves the projections alone with a normal depth buffer', () => {
      const { xr, eyes } = setup()
      const before = eyes[0].projectionMatrix.clone()
      xr.updateCamera(new PerspectiveCamera())
      expect(eyes[0].projectionMatrix.equals(before)).toBe(true)
    })

    it('maps the near plane to depth 1 and the far one to 0', () => {
      const m = reverseDepthMatrix(new Matrix4().makePerspective(-0.1, 0.1, 0.1, -0.1, 0.1, 100))
      const depthAt = (z: number) => {
        const v = new Vector4(0, 0, -z, 1).applyMatrix4(m)
        return v.z / v.w
      }
      expect(depthAt(0.1)).toBeCloseTo(1)
      expect(depthAt(100)).toBeCloseTo(0)
    })
  })
})
