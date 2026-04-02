import { bench, describe } from 'vitest'
import EventEmitter from '../../src/Utils/EventEmitter'

describe('eventEmitter', () => {
  bench('trigger — unknown event (no listeners)', () => {
    const emitter = new EventEmitter()
    emitter.trigger('tick')
  })

  bench('trigger — 1 listener', () => {
    const emitter = new EventEmitter()
    emitter.on('tick', () => {})
    emitter.trigger('tick', { delta: 0.016 })
  })

  bench('trigger — 10 listeners', () => {
    const emitter = new EventEmitter()
    for (let i = 0; i < 10; i++) {
      emitter.on('tick', () => {})
    }
    emitter.trigger('tick', { delta: 0.016 })
  })

  bench('on — register listener', () => {
    const emitter = new EventEmitter()
    emitter.on('tick', () => {})
  })

  bench('off — remove 1 of 10 listeners', () => {
    const emitter = new EventEmitter()
    const cb = () => {}
    for (let i = 0; i < 9; i++) emitter.on('tick', () => {})
    emitter.on('tick', cb)
    emitter.off('tick', cb)
  })
})
