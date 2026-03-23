import { describe, expect, it, vi } from 'vitest'
import EventEmitter from '../../src/Utils/EventEmitter'

describe('eventEmitter', () => {
  it('triggers registered callbacks', () => {
    const emitter = new EventEmitter()
    const cb = vi.fn()
    emitter.on('evt', cb)
    emitter.trigger('evt', 123)
    expect(cb).toHaveBeenCalledWith(123)
  })

  it('supports multiple callbacks', () => {
    const emitter = new EventEmitter()
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    emitter.on('evt', cb1)
    emitter.on('evt', cb2)
    emitter.trigger('evt')
    expect(cb1).toHaveBeenCalled()
    expect(cb2).toHaveBeenCalled()
  })

  it('removes a specific callback with off', () => {
    const emitter = new EventEmitter()
    const cb = vi.fn()
    emitter.on('evt', cb)
    emitter.off('evt', cb)
    emitter.trigger('evt')
    expect(cb).not.toHaveBeenCalled()
  })

  it('only removes the specified callback, leaving others intact', () => {
    const emitter = new EventEmitter()
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    emitter.on('evt', cb1)
    emitter.on('evt', cb2)
    emitter.off('evt', cb1)
    emitter.trigger('evt')
    expect(cb1).not.toHaveBeenCalled()
    expect(cb2).toHaveBeenCalled()
  })

  it('off is a no-op for an unknown event', () => {
    const emitter = new EventEmitter()
    const cb = vi.fn()
    expect(() => emitter.off('unknown', cb)).not.toThrow()
  })
})
