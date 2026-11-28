// @vitest-environment jsdom
import { DirectionalLight, EventDispatcher, Group, Matrix4, PerspectiveCamera, RenderTarget, Scene, Vector4 } from 'three'
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

/** `supportsLayers`: whether three found the browser's Layers API when the renderer was made */
function setup(options?: ConstructorParameters<typeof XR>[2], { supportsLayers = true } = {}) {
  const session = {
    end: vi.fn().mockResolvedValue(undefined),
  }
  const eyes = [
    new PerspectiveCamera(),
    new PerspectiveCamera(),
  ]
  // three's own, which the XR wraps
  const setSession = vi.fn().mockResolvedValue(undefined)
  const xr = Object.assign(new EventDispatcher<any>(), {
    enabled: false,
    isPresenting: false,
    _supportsLayers: supportsLayers,
    setReferenceSpaceType: vi.fn(),
    setSession,
    getSession: vi.fn((): any => null),
    updateCamera: vi.fn(),
    getCamera: () => ({ cameras: eyes }),
    getFrame: vi.fn((): any => ({})),
  })
  const draw = vi.fn()
  const renderTarget = { current: null as RenderTarget | null }
  // While presenting, three's output render target is the headset's and its canvas target has the headset's size
  const viewport = new Vector4()
  const webgl = {
    xr,
    reversedDepthBuffer: false,
    outputRenderTarget: null as RenderTarget | null,
    _canvasTarget: {
      _width: 4032,
      _height: 2240,
    },
    domElement: {
      width: 2560,
      height: 1440,
    },
    getRenderTarget: vi.fn(() => renderTarget.current),
    setRenderTarget: vi.fn((target: RenderTarget | null) => renderTarget.current = target),
    getOutputRenderTarget: () => webgl.outputRenderTarget,
    setOutputRenderTarget: (target: RenderTarget | null) => webgl.outputRenderTarget = target,
    getViewport: (target: Vector4) => target.copy(viewport),
    setViewport: (x: number | Vector4, y?: number, width?: number, height?: number) => typeof x === 'number'
      ? viewport.set(x, y!, width!, height!)
      : viewport.copy(x),
    viewport,
    render: draw,
  }
  // Toggles the renderer's reversed depth buffer
  const depth = {
    get reversed() {
      return webgl.reversedDepthBuffer
    },
    set reversed(value: boolean) {
      webgl.reversedDepthBuffer = value
    },
  }
  const renderer = {
    instance: webgl,
    get xrPresenting() {
      return xr.isPresenting
    },
    // A desktop frame, through the pipeline
    render: vi.fn(),
  }
  // The page: the game's canvas, with its UI root before it
  const canvas = document.createElement('canvas')
  const uiRoot = document.createElement('div')
  document.body.append(uiRoot, canvas)
  const game = {
    trigger: vi.fn(),
    camera: {
      rig: new Group(),
      instance: new PerspectiveCamera(35, 2, 0.1, 500),
    },
    scene: new Scene(),
    canvas,
    uiRoot,
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
    setSession,
    game,
    session,
    webgl,
    renderer,
    renderTarget,
    depth,
    eyes,
  }
}

const backdrop = () => document.querySelector<HTMLElement>('.xr-backdrop')

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
    const { instance, xr, setSession, session } = setup({
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
    expect(setSession).toHaveBeenCalledWith(session)

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

  it('covers the page with its last frame, saying the game plays in VR, while a headset plays without the mirror', async () => {
    const { xr, setSession, session, renderer, game } = setup()
    // The desktop frame is drawn before three.js has the session, which clears the canvas
    setSession.mockImplementation(async () => {
      expect(renderer.render).toHaveBeenCalled()
      expect(backdrop()).not.toBeNull()
    })

    await xr.setSession(session as unknown as XRSession)
    expect(setSession).toHaveBeenCalledWith(session)
    expect(backdrop()!.textContent).toBe('Playing in VR')
    expect(backdrop()!.style.pointerEvents).toBe('none')
    // Under the game's UI
    expect(backdrop()!.nextElementSibling).toBe(game.uiRoot)

    xr.dispatchEvent({ type: 'sessionend' })
    expect(backdrop()).toBeNull()
  })

  it('leaves the page to the mirror, also when it\'s turned on during the session', async () => {
    const mirrored = setup({ mirror: true })
    await mirrored.xr.setSession(mirrored.session as unknown as XRSession)
    expect(backdrop()).toBeNull()
    expect(mirrored.renderer.render).not.toHaveBeenCalled()

    document.body.innerHTML = ''
    const { instance, xr, session } = setup()
    await xr.setSession(session as unknown as XRSession)
    expect(backdrop()).not.toBeNull()
    instance.mirror = true
    instance.renderMirror()
    expect(backdrop()).toBeNull()
  })

  it('mirrors the headset to the page from the head, shaped like the window, without touching the headset', () => {
    const { instance, game, webgl, renderTarget } = setup({ mirror: true })
    const headsetTarget = new RenderTarget(1, 1)
    renderTarget.current = headsetTarget
    const sun = new DirectionalLight()
    sun.castShadow = true
    const unshadowed = new DirectionalLight()
    game.scene.add(sun, unshadowed)
    // Where the headset's frame put the camera, in the rig like the real one
    game.camera.rig.add(game.camera.instance)
    game.camera.rig.position.set(10, 0, 0)
    game.camera.instance.position.set(0, 1.7, 0)
    game.camera.instance.rotation.set(0, Math.PI / 2, 0)
    game.camera.rig.updateMatrixWorld(true)

    const headsetOutput = new RenderTarget(4032, 2240)
    webgl.outputRenderTarget = headsetOutput
    webgl.viewport.set(0, 0, 4032, 2240)

    let during: { xr: boolean, shadows: boolean, target: unknown, output: unknown, canvas: number[], viewport: number[] } | undefined
    webgl.render.mockImplementation(() => {
      during = {
        xr: webgl.xr.enabled,
        shadows: sun.shadow.autoUpdate,
        target: renderTarget.current,
        output: webgl.outputRenderTarget,
        canvas: [webgl._canvasTarget._width, webgl._canvasTarget._height],
        viewport: webgl.viewport.toArray(),
      }
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

    // Drawn to the page, at the page's size, with XR off and the headset's shadow maps, then everything put back
    expect(during).toEqual({
      xr: false,
      shadows: false,
      target: null,
      output: null,
      canvas: [2560, 1440],
      viewport: [0, 0, 2560, 1440],
    })
    expect(webgl.xr.enabled).toBe(true)
    expect(sun.shadow.autoUpdate).toBe(true)
    expect(unshadowed.shadow.autoUpdate).toBe(true)
    expect(renderTarget.current).toBe(headsetTarget)
    expect(webgl.outputRenderTarget).toBe(headsetOutput)
    expect([webgl._canvasTarget._width, webgl._canvasTarget._height]).toEqual([4032, 2240])
    expect(webgl.viewport.toArray()).toEqual([0, 0, 4032, 2240])
  })

  it('puts XR and the headset\'s output back on even when the mirror\'s render throws', () => {
    const { instance, webgl } = setup({ mirror: true })
    const headsetOutput = new RenderTarget(4032, 2240)
    webgl.outputRenderTarget = headsetOutput
    webgl.xr.enabled = true
    webgl.render.mockImplementation(() => {
      throw new Error('lost context')
    })

    expect(() => instance.renderMirror()).toThrow('lost context')
    expect(webgl.xr.enabled).toBe(true)
    expect(webgl.outputRenderTarget).toBe(headsetOutput)
    expect([webgl._canvasTarget._width, webgl._canvasTarget._height]).toEqual([4032, 2240])
  })

  describe('renderer fixes', () => {
    it('draws to a projection layer only in a session given the layers feature', async () => {
      const { xr, setSession } = setup()
      const granted = {
        enabledFeatures: ['local-floor', 'layers'],
      } as unknown as XRSession
      const refused = {
        enabledFeatures: ['local-floor'],
      } as unknown as XRSession

      // Chrome on Windows has the Layers API but doesn't grant the feature
      await xr.setSession(refused)
      expect(xr._supportsLayers).toBe(false)
      expect(setSession).toHaveBeenLastCalledWith(refused)

      await xr.setSession(granted)
      expect(xr._supportsLayers).toBe(true)
      expect(setSession).toHaveBeenLastCalledWith(granted)
    })

    it('never draws to a projection layer where the browser has no Layers API', async () => {
      const { xr } = setup({}, { supportsLayers: false })

      await xr.setSession({
        enabledFeatures: ['layers'],
      } as unknown as XRSession)
      expect(xr._supportsLayers).toBe(false)
    })

    it('lets the headset\'s layer draw to the default framebuffer, which WebXR gives as null', () => {
      const { xr, webgl } = setup()
      const drawBuffers = vi.fn()
      const state = { drawBuffers }
      Object.assign(webgl, {
        backend: { state },
      })
      const framebuffer = {} as WebGLFramebuffer

      xr.dispatchEvent({ type: 'sessionstart' })
      xr.dispatchEvent({ type: 'sessionstart' })
      state.drawBuffers({
        textures: ['color'],
      }, framebuffer)
      state.drawBuffers({
        textures: ['color'],
      }, null)

      // A framebuffer of its own goes through as it was, the default one as no render target
      expect(drawBuffers.mock.calls).toEqual([
        [
          {
            textures: ['color'],
          },
          framebuffer,
        ],
        [
          { textures: null },
          null,
        ],
      ])
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
