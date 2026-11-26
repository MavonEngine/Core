import { AnimationClip, Group, NumberKeyframeTrack, Scene } from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Entity3D from '../../src/World/Entity3D'

const callbacks: Record<string, ((event?: any) => void)[]> = {}
const mockGame = {
  scene: new Scene(),
  on: vi.fn((name: string, callback: (event?: any) => void) => {
    (callbacks[name] ??= []).push(callback)
  }),
  off: vi.fn((name: string, callback: (event?: any) => void) => {
    callbacks[name] = (callbacks[name] ?? []).filter(cb => cb !== callback)
  }),
}

vi.mock('../../src/Game', () => ({
  default: {
    instance: () => mockGame,
  },
}))

class Model extends Entity3D {
  load() {
    const scene = new Group()
    const clip = new AnimationClip('wave', 1, [
      new NumberKeyframeTrack('.position[x]', [0, 1], [0, 10]),
    ])
    this.initModel({
      scene,
      animations: [clip],
    } as any)
  }
}

describe('entity3D', () => {
  beforeEach(() => {
    for (const name of Object.keys(callbacks))
      delete callbacks[name]
    mockGame.scene = new Scene()
  })

  it('advances its animations every rendered frame, not every tick', () => {
    const model = new Model()
    model.load()
    model.animationsMap.get('wave')!.play()

    model.update(0.5)
    expect(model.animationMixer!.time).toBe(0)

    callbacks.beforeRender.forEach(cb => cb(0.25))
    expect(model.animationMixer!.time).toBeCloseTo(0.25)
  })

  it('listens for frames once, however often its model is set, and stops when destroyed', () => {
    const model = new Model()
    model.load()
    model.load()
    expect(callbacks.beforeRender).toHaveLength(1)

    model.destroy()
    expect(callbacks.beforeRender).toHaveLength(0)
  })
})
