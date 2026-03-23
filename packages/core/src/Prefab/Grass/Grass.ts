import type { ContainerApi } from '@tweakpane/core'
import type { BufferGeometry } from 'three'
import type { GLTF } from 'three/examples/jsm/Addons.js'
import { WithEditorHelper } from '../../Editor/WithEditorHelper'
import Game from '../../Game'
import { randRange } from '../../Utils/Math'
import Entity3D from '../../World/Entity3D'
import {
  Box3,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Sphere,
  Vector3,
} from 'three'
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js'
import FragmentShader from './Fragment.glsl'
import VertexShader from './Vertex.glsl'

const MAX_PUSH_POINTS = 150

export default class Grass extends WithEditorHelper(Entity3D) {
  material?: ShaderMaterial
  lowResMaterial?: ShaderMaterial
  instancePositions: Float32Array
  mesh?: Mesh
  lowResMesh?: Mesh

  private highGeometry?: BufferGeometry
  private lowGeometry?: BufferGeometry
  private patchSize: number
  private coordCallback?: (x: number, y: number) => number

  constructor(
    highModel: GLTF,
    lowModel: GLTF,
    grassBlades = 200000,
    patchSize = 12.5,
    position = new Vector3(),
    coordCallback?: (x: number, y: number) => number,
  ) {
    super()

    this.instancePositions = new Float32Array(grassBlades * 3)
    this.patchSize = patchSize
    this.position = position
    this.coordCallback = coordCallback
    this.registerEditorHelper(position, 'Grass', this)

    const onLoad = () => {
      const highSource = clone(highModel.scene.clone()).children.find(child => child instanceof Mesh) as Mesh
      const lowSource = clone(lowModel.scene.clone()).children.find(child => child instanceof Mesh) as Mesh

      if (!highSource || !lowSource) {
        console.error('No mesh found in model')
        return
      }

      this.highGeometry = highSource.geometry.clone()
      this.highGeometry.rotateZ(Math.PI / 180 * 90)
      this.lowGeometry = lowSource.geometry.clone()
      this.lowGeometry.rotateZ(Math.PI / 180 * 90)

      this.build(grassBlades)
      Game.instance().scene.add(this.mesh!, this.lowResMesh!)
    }

    if (Game.instance().resources.loaded) {
      onLoad()
    }
    else {
      Game.instance().resources.on('loaded', onLoad)
    }
  }

  private build(grassBlades: number): void {
    const { patchSize, position, coordCallback } = this

    const positions = new Float32Array(grassBlades * 3)
    const instanceRotation = new Float32Array(grassBlades)
    const instanceScales = new Float32Array(grassBlades)

    let bladeIndex = 0
    while (bladeIndex < grassBlades) {
      const x = randRange(-patchSize, patchSize)
      const z = randRange(-patchSize, patchSize)

      const distSq = x * x + z * z
      const maxDistSq = patchSize * patchSize
      const densityFalloff = Math.exp(-distSq / (maxDistSq * 0.1))

      if (Math.random() < densityFalloff) {
        positions[bladeIndex * 3] = x
        positions[bladeIndex * 3 + 1] = coordCallback ? coordCallback(x, z) : 0
        positions[bladeIndex * 3 + 2] = z

        instanceRotation[bladeIndex] = Math.random() * Math.PI * 2
        instanceScales[bladeIndex] = randRange(2.3, 3.5)

        bladeIndex++
      }
    }

    const instanceLeans = new Float32Array(grassBlades)
    for (let i = 0; i < grassBlades; i++) {
      instanceLeans[i] = randRange(-0.4, 0.4)
    }

    const buildGeometry = (baseGeometry: BufferGeometry) => {
      const geometry = new InstancedBufferGeometry()
      geometry.index = baseGeometry.index
      geometry.attributes = { ...baseGeometry.attributes }

      geometry.setAttribute('offset', new InstancedBufferAttribute(positions, 3))
      geometry.setAttribute('rotationAngle', new InstancedBufferAttribute(instanceRotation, 1))
      geometry.setAttribute('instanceScale', new InstancedBufferAttribute(instanceScales, 1))
      geometry.setAttribute('randomLean', new InstancedBufferAttribute(instanceLeans, 1))

      geometry.instanceCount = grassBlades

      geometry.boundingBox = new Box3(
        new Vector3(-patchSize, -patchSize, -patchSize),
        new Vector3(patchSize, patchSize, patchSize),
      )
      geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new Sphere())

      const material = new ShaderMaterial({
        vertexShader: VertexShader,
        fragmentShader: FragmentShader,
        side: DoubleSide,
        uniforms: {
          uTime: { value: 0 },
          pushPositions: {
            value: Array.from({ length: MAX_PUSH_POINTS }, () => new Vector3()),
          },
          pushRadii: {
            value: Array.from({ length: MAX_PUSH_POINTS }).fill(0),
          },
        },
      })

      const mesh = new Mesh(geometry, material)
      mesh.position.copy(position)
      mesh.userData.grassInstance = this
      mesh.raycast = (raycaster, intersects) => {
        if (!Game.instance().editor)
          return
        if (!geometry.boundingBox)
          return
        const box = new Box3().copy(geometry.boundingBox).applyMatrix4(mesh.matrixWorld)
        const target = new Vector3()
        if (raycaster.ray.intersectBox(box, target)) {
          intersects.push({
            distance: raycaster.ray.origin.distanceTo(target),
            point: target.clone(),
            object: mesh,
          } as any)
        }
      }

      return { mesh, material }
    }

    if (this.mesh) {
      // Reallocation: swap geometry on existing meshes
      this.mesh.geometry.dispose()
      this.lowResMesh!.geometry.dispose()
      const highGeo = buildGeometry(this.highGeometry!).mesh.geometry as InstancedBufferGeometry
      const lowGeo = buildGeometry(this.lowGeometry!).mesh.geometry as InstancedBufferGeometry
      this.mesh.geometry = highGeo
      this.lowResMesh!.geometry = lowGeo
      this.instancePositions = positions
    }
    else {
      // Initial build
      const high = buildGeometry(this.highGeometry!)
      this.mesh = high.mesh
      this.material = high.material
      this.instancePositions = positions

      const low = buildGeometry(this.lowGeometry!)
      this.lowResMesh = low.mesh
      this.lowResMaterial = low.material
      this.lowResMesh.visible = false

      this.tagWithHelper(this.mesh)
      this.tagWithHelper(this.lowResMesh)
    }
  }

  reallocate(grassBlades: number): void {
    if (!this.highGeometry || !this.lowGeometry)
      return
    this.build(grassBlades)
  }

  addBindings(folder: ContainerApi): void {
    const proxy = { bladeCount: this.mesh?.geometry.getAttribute('offset')?.count ?? 0 }
    folder.addBinding(proxy, 'bladeCount', { min: 1000, max: 50000, step: 1000, label: 'Blade Count' })
      .on('change', ({ value }) => this.reallocate(value))
  }

  destroy(): void {
    this.material?.dispose()
    this.lowResMaterial?.dispose()
    this.mesh?.geometry.dispose()
    this.lowResMesh?.geometry.dispose()
    Game.instance().scene.remove(this.mesh!, this.lowResMesh!)
    super.destroy()
  }

  setPushPoints(points: { position: Vector3, radius: number }[]) {
    const materials = [this.material, this.lowResMaterial].filter(
      (m): m is ShaderMaterial => !!m,
    )
    if (!materials.length)
      return

    for (let i = 0; i < MAX_PUSH_POINTS; i++) {
      if (points[i]) {
        materials.forEach((mat) => {
          mat.uniforms.pushPositions.value[i].copy(points[i].position)
          mat.uniforms.pushRadii.value[i] = points[i].radius
        })
      }
    }
  }

  update(delta: number): void {
    [this.material, this.lowResMaterial].forEach((mat) => {
      if (mat)
        mat.uniforms.uTime.value += delta
    })

    const cameraPos = Game.instance().camera.instance.position
    const distance = cameraPos.distanceTo(this.mesh!.position)

    if (this.lowResMesh) {
      if (distance > 20) {
        this.lowResMesh.visible = true
        this.mesh!.visible = false
      }
      else {
        this.lowResMesh.visible = false
        this.mesh!.visible = true
      }
    }
  }
}
