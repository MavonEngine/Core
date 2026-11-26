import type { Camera } from 'three'
import { CanvasTexture, LinearFilter, Sprite, SpriteMaterial, SRGBColorSpace, Vector3 } from 'three'

export interface TextLabelOptions {
  /** CSS font, at the size the text is drawn on the canvas. Default `'600 40px system-ui, sans-serif'` */
  font?: string
  /** Text colour. Default white */
  color?: string
  /** Background behind the text, or `''` for none. Default translucent black */
  background?: string
  /** Space around the text, in canvas pixels. Default a third of the font's height */
  padding?: number
  /** The background's corner radius, in canvas pixels. Default half the padding */
  radius?: number
  /**
   * The label's height in the world, in meters. Ignored when `angularSize` is set. Default 0.25
   */
  height?: number
  /**
   * Keep the label the same size in view whatever its distance, as a screen label is: its height as an angle, in
   * degrees (2 reads like 14 px text on a desktop monitor). Call `update(camera)` every rendered frame for it
   */
  angularSize?: number
  /** Hidden by the scene in front of it, as anything else. Default false: always readable, drawn over the scene */
  depthTest?: boolean
}

const DEFAULTS = {
  font: '600 40px system-ui, sans-serif',
  color: '#fff',
  background: 'rgba(0, 0, 0, 0.45)',
  height: 0.25,
  depthTest: false,
}

const temp = new Vector3()

/**
 * Text drawn in the scene, always facing the viewer: a sprite with the text on a canvas texture. For what a VR
 * headset has to show, where the page's HTML can't be seen, like a player's name over their head.
 *
 * It's unlit and left out of tone mapping and fog, so the text keeps its colours, and drawn over the scene unless
 * `depthTest` is set. Add it to the scene, or as a child of what it labels; with `angularSize`, call `update(camera)`
 * every rendered frame (e.g. on the game's `beforeRender`).
 */
export default class TextLabel extends Sprite {
  readonly canvas = document.createElement('canvas')
  readonly options: Required<Omit<TextLabelOptions, 'angularSize' | 'padding' | 'radius'>> & Pick<TextLabelOptions, 'angularSize' | 'padding' | 'radius'>
  declare material: SpriteMaterial
  private texture: CanvasTexture
  private _text = ''
  /** The text's width over its height, for the sprite's shape */
  private aspect = 1

  constructor(text = '', options: TextLabelOptions = {}) {
    const texture = new CanvasTexture(document.createElement('canvas'))
    super(new SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: options.depthTest ?? DEFAULTS.depthTest,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    }))
    texture.image = this.canvas
    texture.colorSpace = SRGBColorSpace
    texture.minFilter = LinearFilter
    texture.generateMipmaps = false
    this.texture = texture
    this.options = {
      ...DEFAULTS,
      ...options,
    }
    this.name = 'TextLabel'
    // Drawn after the scene, so it isn't hidden by what's drawn later
    this.renderOrder = 1000
    this.castShadow = false
    this.receiveShadow = false
    this.setText(text)
  }

  get text() {
    return this._text
  }

  /** Change the text; redrawn only when it changes. Lines split on `\n` */
  setText(text: string) {
    if (text === this._text && this.canvas.width > 1)
      return
    this._text = text
    this.draw()
  }

  private draw() {
    const ctx = this.canvas.getContext('2d')
    if (!ctx)
      return

    const { font, color, background } = this.options
    ctx.font = font
    const lines = this._text.split('\n')
    const size = fontSize(font)
    const lineHeight = Math.ceil(size * 1.25)
    const padding = this.options.padding ?? Math.round(size / 3)
    const radius = this.options.radius ?? padding / 2
    const textWidth = Math.max(1, ...lines.map(line => Math.ceil(ctx.measureText(line).width)))

    this.canvas.width = textWidth + padding * 2
    this.canvas.height = lineHeight * lines.length + padding * 2
    // Resizing the canvas resets its state
    ctx.font = font
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    if (background && this._text) {
      ctx.fillStyle = background
      ctx.beginPath()
      ctx.roundRect(0, 0, this.canvas.width, this.canvas.height, radius)
      ctx.fill()
    }
    ctx.fillStyle = color
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    lines.forEach((line, i) => ctx.fillText(line, this.canvas.width / 2, padding + lineHeight * (i + 0.5)))

    this.aspect = this.canvas.width / this.canvas.height
    // A new size needs a new GPU texture
    this.texture.dispose()
    this.texture.needsUpdate = true
    this.visible = this._text !== ''
    this.resize(this.options.height)
  }

  private resize(height: number) {
    this.scale.set(height * this.aspect, height, 1)
  }

  /**
   * With `angularSize`, scale the label so it keeps that size in view of `camera` (in VR, the headset's view: the
   * game's camera). The camera's world matrix is read as it is: updated by the last render
   */
  update(camera: Camera) {
    if (this.options.angularSize === undefined)
      return
    this.getWorldPosition(temp)
    const distance = temp.distanceTo(camera.getWorldPosition(new Vector3()))
    const height = 2 * distance * Math.tan(this.options.angularSize * Math.PI / 360)
    // The scale is in the parent's space
    const parentScale = this.parent
      ? this.parent.getWorldScale(new Vector3()).y
      : 1
    this.resize(height / (parentScale || 1))
  }

  dispose() {
    this.texture.dispose()
    this.material.dispose()
    this.removeFromParent()
  }
}

/** The pixel size in a CSS font, e.g. 40 for `'600 40px system-ui'` */
function fontSize(font: string) {
  const match = /(\d+(?:\.\d+)?)px/.exec(font)
  return match
    ? Number(match[1])
    : 16
}
