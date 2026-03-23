import * as EssentialsPlugin from '@tweakpane/plugin-essentials'
import { Pane } from 'tweakpane'
import EventEmitter from './EventEmitter'

export default class Debug extends EventEmitter {
  active: boolean
  ui?: Pane

  constructor() {
    super()

    this.active = window.location.hash === '#debug'

    if (this.active) {
      this.ui = new Pane()
      this.ui.registerPlugin(EssentialsPlugin)

      this.trigger('debug')
    }
  }
}
