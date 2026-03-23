export function EventEmitterMixin<TBase extends new (...args: any[]) => object>(Base: TBase) {
  return class extends Base {
    callbacks: { [key: string]: ((event?: any) => void)[] } = {}

    on(event: string, callback: (event?: any) => void) {
      if (!this.callbacks[event]) {
        this.callbacks[event] = [callback]
      }
      else {
        this.callbacks[event].push(callback)
      }
    }

    off(event: string, callback: (event?: any) => void) {
      if (this.callbacks[event]) {
        this.callbacks[event] = this.callbacks[event].filter(cb => cb !== callback)
      }
    }

    trigger(name: string, event?: any) {
      if (this.callbacks[name]) {
        this.callbacks[name].forEach((callback) => {
          callback(event)
        })
      }
    }
  }
}

export default class EventEmitter extends EventEmitterMixin(class {}) {}
