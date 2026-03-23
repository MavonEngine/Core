import EventEmitter from './EventEmitter'

export default class Sizes extends EventEmitter {
  width: number
  height: number
  pixelRatio: number

  constructor() {
    super()

    this.width = window.innerWidth
    this.height = window.innerHeight
    this.pixelRatio = Math.min(window.devicePixelRatio, 2)

    window.addEventListener('resize', () => {
      this.setSize(window.innerWidth, window.innerHeight)
    })
  }

  setSize(width: number, height: number) {
    this.width = width
    this.height = height
    this.pixelRatio = Math.min(window.devicePixelRatio, 2)

    this.trigger('resize')
  }
}
