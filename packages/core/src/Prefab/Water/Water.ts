import type { Vector3 } from 'three'
import { WithEditorHelper } from '../../Editor/WithEditorHelper'
import Game from '../../Game'
import GameObject from '../../World/GameObject'
import { Color, EqualStencilFunc, IncrementStencilOp, Mesh, PlaneGeometry, ShaderMaterial, Vector3 as Vec3, Vector2 } from 'three'
import FragmentShader from './Fragment.glsl'
import VertexShader from './Vertex.glsl'
import WaterManager from './WaterManager'

const MAX_PUSH_POINTS = 150

export interface WaterLODConfig {
  segments: [close: number, medium: number, far: number]
  distances: [closeToMedium: number, mediumToFar: number]
}

interface WaterSection {
  mesh: Mesh
  sectionSize: number
  currentLOD: number
}

const DEFAULT_LOD: WaterLODConfig = {
  segments: [512, 128, 32],
  distances: [40, 60],
}

/**
 * https://threejs-journey.com/lessons/raging-sea
 */
export default class Water extends WithEditorHelper(GameObject) {
  material: ShaderMaterial
  private sections: WaterSection[] = []
  private lodConfig: WaterLODConfig
  private sectionCount: number
  private cullHeight?: (worldX: number, worldZ: number) => number
  private cullPadding = 0

  constructor(
    position: Vector3,
    size: number,
    sectionCount: number = 1,
    lod: WaterLODConfig = DEFAULT_LOD,
  ) {
    super(undefined, position)
    this.lodConfig = lod
    this.sectionCount = sectionCount

    this.material = new ShaderMaterial({
      transparent: true,
      stencilWrite: true,
      stencilFunc: EqualStencilFunc,
      stencilRef: 0,
      stencilZPass: IncrementStencilOp,
      fragmentShader: FragmentShader,
      vertexShader: VertexShader,
      uniforms: {
        uTime: { value: 0 },

        uBigWavesElevation: { value: 0.380 },
        uBigWavesFrequency: { value: new Vector2(0.326, 0.978) },
        uBigWavesSpeed: { value: 1.0 },

        uDepthColor: { value: new Color('#186691') },
        uSurfaceColor: { value: new Color('#9bd8ff') },
        uColorOffset: { value: 0.380 },
        uColorMultiplier: { value: 0.761 },

        pushPositions: {
          value: Array.from({ length: MAX_PUSH_POINTS }, () => new Vec3()),
        },
        pushRadii: {
          value: Array.from({ length: MAX_PUSH_POINTS }).fill(0),
        },

        uSunDirection: { value: new Vec3(0, 1, 0) },
        uSunReflectionStrength: { value: 1.0 },
      },
    })

    const sectionSize = size / sectionCount

    for (let gx = 0; gx < sectionCount; gx++) {
      for (let gz = 0; gz < sectionCount; gz++) {
        const offsetX = (gx - (sectionCount - 1) / 2) * sectionSize
        const offsetZ = (gz - (sectionCount - 1) / 2) * sectionSize

        const farSegments = Math.max(1, Math.round(lod.segments[2] / sectionCount))
        const geoSize = sectionSize * 1.02
        const geometry = new PlaneGeometry(geoSize, geoSize, farSegments, farSegments)
        const mesh = new Mesh(geometry, this.material)
        mesh.position.set(
          this.position.x + offsetX,
          this.position.y,
          this.position.z + offsetZ,
        )
        mesh.rotation.x = -Math.PI * 0.5

        this.sections.push({ mesh, sectionSize, currentLOD: 2 })
        Game.instance().scene.add(mesh)
      }
    }

    this.registerEditorHelper(position, 'Water', {
      addBindings: folder => WaterManager.instance?.addBindings(folder),
    })
    for (const section of this.sections)
      this.tagWithHelper(section.mesh)
    this.addDebugTools()
  }

  private addDebugTools() {
    if (!Game.instance().debug.active || !WaterManager.instance)
      return

    WaterManager.instance.uBigWavesElevationController?.on('change', (ev) => {
      this.material.uniforms.uBigWavesElevation.value = ev.value
    })

    WaterManager.instance.uBigWavesFrequencyControllerX?.on('change', (ev) => {
      this.material.uniforms.uBigWavesFrequency.value.setX(ev.value)
    })

    WaterManager.instance.uBigWavesFrequencyControllerY?.on('change', (ev) => {
      this.material.uniforms.uBigWavesFrequency.value.setY(ev.value)
    })

    WaterManager.instance.uBigWavesSpeedController?.on('change', (ev) => {
      this.material.uniforms.uBigWavesSpeed.value = ev.value
    })

    WaterManager.instance.uDepthColorController?.on('change', (ev) => {
      this.material.uniforms.uDepthColor.value = new Color(ev.value)
    })

    WaterManager.instance.uSurfaceColorController?.on('change', (ev) => {
      this.material.uniforms.uSurfaceColor.value = new Color(ev.value)
    })

    WaterManager.instance.uColorOffsetController?.on('change', (ev) => {
      this.material.uniforms.uColorOffset.value = ev.value
    })

    WaterManager.instance.uColorMultiplierController?.on('change', (ev) => {
      this.material.uniforms.uColorMultiplier.value = ev.value
    })

    WaterManager.instance.uSunReflectionStrengthController?.on('change', (ev) => {
      this.material.uniforms.uSunReflectionStrength.value = ev.value
    })
  }

  private swapGeometry(section: WaterSection, targetLOD: number) {
    const segments = Math.max(1, Math.round(this.lodConfig.segments[targetLOD] / this.sectionCount))
    const oldGeometry = section.mesh.geometry

    const geoSize = section.sectionSize * 1.05
    const newGeometry = new PlaneGeometry(
      geoSize,
      geoSize,
      segments,
      segments,
    )

    if (this.cullHeight) {
      this.cullGeometry(newGeometry, section.mesh, this.cullHeight, this.cullPadding)
    }

    section.mesh.geometry = newGeometry
    section.currentLOD = targetLOD
    oldGeometry.dispose()
  }

  private cullGeometry(
    geometry: PlaneGeometry,
    mesh: Mesh,
    getHeight: (worldX: number, worldZ: number) => number,
    padding: number,
  ) {
    const position = geometry.attributes.position
    const index = geometry.index
    if (!index)
      return

    const culled = new Uint8Array(position.count)

    for (let i = 0; i < position.count; i++) {
      const worldX = position.getX(i) + mesh.position.x
      const worldZ = -position.getY(i) + mesh.position.z
      const terrainHeight = getHeight(worldX, worldZ)

      if (terrainHeight - padding > mesh.position.y) {
        culled[i] = 1
      }
    }

    const oldIndices = index.array
    const newIndices: number[] = []

    for (let i = 0; i < oldIndices.length; i += 3) {
      const a = oldIndices[i]
      const b = oldIndices[i + 1]
      const c = oldIndices[i + 2]

      if (!culled[a] || !culled[b] || !culled[c]) {
        newIndices.push(a, b, c)
      }
    }

    geometry.setIndex(newIndices)
  }

  /**
   * Removes triangles where all 3 vertices are beneath the surface returned by
   * `getHeight`. The callback is stored so culling is automatically re-applied
   * whenever a section swaps LOD.
   */
  cullVertices(
    getHeight: (worldX: number, worldZ: number) => number,
    padding: number = 0,
  ): void {
    this.cullHeight = getHeight
    this.cullPadding = padding

    for (const section of this.sections) {
      this.cullGeometry(
        section.mesh.geometry as PlaneGeometry,
        section.mesh,
        getHeight,
        padding,
      )
    }
  }

  setPushPoints(points: { position: Vector3, radius: number }[]) {
    for (let i = 0; i < MAX_PUSH_POINTS; i++) {
      if (points[i]) {
        this.material.uniforms.pushPositions.value[i].copy(points[i].position)
        this.material.uniforms.pushRadii.value[i] = points[i].radius
      }
    }
  }

  update(_delta: number): void {
    this.material.uniforms.uTime.value = Game.instance().clock.elapsedTime

    if (WaterManager.instance) {
      this.material.uniforms.uSunDirection.value.copy(WaterManager.instance.sunPosition)
    }

    const cameraPos = Game.instance().camera.instance.position

    for (const section of this.sections) {
      const distance = cameraPos.distanceTo(section.mesh.position)

      let targetLOD: number
      if (distance < this.lodConfig.distances[0]) {
        targetLOD = 0
      }
      else if (distance < this.lodConfig.distances[1]) {
        targetLOD = 1
      }
      else {
        targetLOD = 2
      }

      if (targetLOD !== section.currentLOD) {
        this.swapGeometry(section, targetLOD)
      }
    }
  }

  destroy(): void {
    for (const section of this.sections) {
      section.mesh.geometry.dispose()
      Game.instance().scene.remove(section.mesh)
    }
    this.material.dispose()

    super.destroy()
  }
}
