import type { BindingApi, ContainerApi } from '@tweakpane/core'
import type Water from './Water'
import { Vector2, Vector3 } from 'three'
import Game from '../../Game'

export default class WaterManager {
  uBigwavesElevation = 0.2
  uBigWavesElevationController: BindingApi<unknown, this['uBigwavesElevation'], any> | undefined

  uBigwavesFrequency = new Vector2(4, 1.5)
  uBigWavesFrequencyControllerX: BindingApi<unknown, this['uBigwavesElevation'], any> | undefined
  uBigWavesFrequencyControllerY: BindingApi<unknown, this['uBigwavesElevation'], any> | undefined

  uBigWavesSpeed = 0.75
  uBigWavesSpeedController: BindingApi<unknown, this['uBigwavesElevation'], any> | undefined

  uSurfaceColor = '#9bd8ff'
  uSurfaceColorController: BindingApi<unknown, this['uBigwavesElevation'], any> | undefined

  uDepthColor = '#186691'
  uDepthColorController: BindingApi<unknown, this['uBigwavesElevation'], any> | undefined

  uColorOffset = 0.08
  uColorOffsetController: BindingApi<unknown, this['uBigwavesElevation'], any> | undefined

  uColorMultiplier = 5.0
  uColorMultiplierController: BindingApi<unknown, this['uBigwavesElevation'], any> | undefined

  sunPosition = new Vector3(0, 1, 0)

  uSunReflectionStrength = 1.0
  uSunReflectionStrengthController: BindingApi<unknown, this['uSunReflectionStrength'], any> | undefined

  waters: Water[] = []

  static instance?: WaterManager

  static init() {
    WaterManager.instance = new WaterManager()
  }

  constructor() {
    WaterManager.instance = this

    if (Game.instance().debug.active || Game.instance().editor) {
      const waterFolder = Game.instance().debug.ui?.addFolder({ title: 'Water' })
      if (waterFolder)
        this.addBindings(waterFolder)
    }
  }

  addBindings(folder: ContainerApi): void {
    this.uBigWavesElevationController = folder.addBinding(this, 'uBigwavesElevation', {
      min: 0,
      max: 1,
      step: 0.001,
      label: 'Height',
    }).on('change', ({ value }) => {
      this.waters.forEach((w) => {
        w.material.uniforms.uBigWavesElevation.value = value
      })
    })

    this.uBigWavesFrequencyControllerX = folder.addBinding(this.uBigwavesFrequency, 'x', {
      min: 0,
      max: 10,
      step: 0.001,
      label: 'FrequencyX',
    }).on('change', ({ value }) => {
      this.waters.forEach((w) => {
        w.material.uniforms.uBigWavesFrequency.value.setX(value)
      })
    })

    this.uBigWavesFrequencyControllerY = folder.addBinding(this.uBigwavesFrequency, 'y', {
      min: 0,
      max: 10,
      step: 0.001,
      label: 'FrequencyY',
    }).on('change', ({ value }) => {
      this.waters.forEach((w) => {
        w.material.uniforms.uBigWavesFrequency.value.setY(value)
      })
    })

    this.uBigWavesSpeedController = folder.addBinding(this, 'uBigWavesSpeed', {
      min: 0,
      max: 4,
      step: 0.001,
      label: 'Speed',
    }).on('change', ({ value }) => {
      this.waters.forEach((w) => {
        w.material.uniforms.uBigWavesSpeed.value = value
      })
    })

    this.uSurfaceColorController = folder.addBinding(this, 'uSurfaceColor', {
      label: 'Surface Color',
      view: 'color',
    }).on('change', ({ value }) => {
      this.waters.forEach((w) => {
        w.material.uniforms.uSurfaceColor.value.set(value)
      })
    })

    this.uDepthColorController = folder.addBinding(this, 'uDepthColor', {
      label: 'Depth Color',
      view: 'color',
    }).on('change', ({ value }) => {
      this.waters.forEach((w) => {
        w.material.uniforms.uDepthColor.value.set(value)
      })
    })

    this.uColorOffsetController = folder.addBinding(this, 'uColorOffset', {
      min: 0,
      max: 1,
      step: 0.001,
      label: 'uColorOffset',
    }).on('change', ({ value }) => {
      this.waters.forEach((w) => {
        w.material.uniforms.uColorOffset.value = value
      })
    })

    this.uColorMultiplierController = folder.addBinding(this, 'uColorMultiplier', {
      min: 0,
      max: 10,
      step: 0.001,
      label: 'uColorMultiplier',
    }).on('change', ({ value }) => {
      this.waters.forEach((w) => {
        w.material.uniforms.uColorMultiplier.value = value
      })
    })

    this.uSunReflectionStrengthController = folder.addBinding(this, 'uSunReflectionStrength', {
      min: 0,
      max: 3,
      step: 0.01,
      label: 'Sun Reflection',
    }).on('change', ({ value }) => {
      this.waters.forEach((w) => {
        w.material.uniforms.uSunReflectionStrength.value = value
      })
    })
  }
}
