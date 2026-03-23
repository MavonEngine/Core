import type {
  BufferGeometry,
  Object3D,
} from 'three'
import {
  BoxGeometry,
  CapsuleGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  EdgesGeometry,
  ExtrudeGeometry,
  IcosahedronGeometry,
  LatheGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  PolyhedronGeometry,
  RingGeometry,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  TetrahedronGeometry,
  TorusGeometry,
  TorusKnotGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  WireframeGeometry,
} from 'three'
import { WithEditorHelper } from '../../Editor/WithEditorHelper'
import Game from '../../Game'
import GameObject from '../../World/GameObject'

export abstract class Primitive extends WithEditorHelper(GameObject) {
  public instance: Object3D

  constructor(position: Vector3, object: Object3D, label: string) {
    super(undefined, position)
    this.instance = object
    this.instance.position.copy(position)
    Game.instance().scene.add(this.instance)
    const isMeshStd = this.instance instanceof Mesh && this.instance.material instanceof MeshStandardMaterial
    const mat = isMeshStd ? (this.instance as Mesh).material as MeshStandardMaterial : null
    this.registerEditorHelper(position, label, {
      onMove: (delta: Vector3) => this.instance.position.add(delta),
      properties: mat
        ? [
            { type: 'color', label: 'color', getValue: () => `#${mat.color.getHexString()}`, setValue: (v: string) => mat.color.set(v) },
            {
              type: 'checkbox',
              label: 'wireframe',
              getValue: () => mat.wireframe,
              setValue: (v: boolean) => {
                mat.wireframe = v
                mat.needsUpdate = true
              },
            },
            { type: 'slider', label: 'roughness', min: 0, max: 1, step: 0.01, getValue: () => mat.roughness, setValue: (v: number) => { mat.roughness = v } },
            { type: 'slider', label: 'metalness', min: 0, max: 1, step: 0.01, getValue: () => mat.metalness, setValue: (v: number) => { mat.metalness = v } },
          ]
        : [],
    })
    this.tagWithHelper(this.instance)
  }

  setReceiveShadow(value: boolean): void {
    if (this.instance instanceof Mesh) {
      this.instance.receiveShadow = value
    }
  }

  setCastShadow(value: boolean): void {
    if (this.instance instanceof Mesh) {
      this.instance.castShadow = value
    }
  }

  update(_delta: number): void { }

  destroy(): void {
    const asRenderable = this.instance as { geometry?: BufferGeometry, material?: MeshStandardMaterial | LineBasicMaterial | (MeshStandardMaterial | LineBasicMaterial)[] }
    asRenderable.geometry?.dispose()
    if (Array.isArray(asRenderable.material)) {
      asRenderable.material.forEach(m => m.dispose())
    }
    else {
      asRenderable.material?.dispose()
    }
    Game.instance().scene.remove(this.instance)
    super.destroy()
  }
}

function mesh(geometry: BufferGeometry): Mesh {
  return new Mesh(geometry, new MeshStandardMaterial({ color: 0x888888 }))
}

function lines(geometry: BufferGeometry): LineSegments {
  return new LineSegments(geometry, new LineBasicMaterial({ color: 0x4A9EFF }))
}

export class BoxPrimitive extends Primitive {
  constructor(position: Vector3) {
    super(position, mesh(new BoxGeometry()), 'Box')
  }
}

export class CapsulePrimitive extends Primitive {
  constructor(position: Vector3) {
    super(position, mesh(new CapsuleGeometry()), 'Capsule')
  }
}

export class CirclePrimitive extends Primitive {
  constructor(position: Vector3) {
    super(position, mesh(new CircleGeometry()), 'Circle')
  }
}

export class ConePrimitive extends Primitive {
  constructor(position: Vector3) {
    super(position, mesh(new ConeGeometry()), 'Cone')
  }
}

export class CylinderPrimitive extends Primitive {
  constructor(position: Vector3) {
    super(position, mesh(new CylinderGeometry()), 'Cylinder')
  }
}

export class DodecahedronPrimitive extends Primitive {
  constructor(position: Vector3) {
    super(position, mesh(new DodecahedronGeometry()), 'Dodecahedron')
  }
}

export class EdgesPrimitive extends Primitive {
  constructor(position: Vector3) {
    super(position, lines(new EdgesGeometry(new BoxGeometry())), 'Edges')
  }
}

export class ExtrudePrimitive extends Primitive {
  constructor(position: Vector3) {
    const shape = new Shape()
    shape.moveTo(0, 0)
    shape.lineTo(0, 1)
    shape.lineTo(1, 1)
    shape.lineTo(1, 0)
    shape.closePath()
    super(position, mesh(new ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: false })), 'Extrude')
  }
}

export class IcosahedronPrimitive extends Primitive {
  constructor(position: Vector3) {
    super(position, mesh(new IcosahedronGeometry()), 'Icosahedron')
  }
}

export class LathePrimitive extends Primitive {
  constructor(position: Vector3) {
    const points: Vector2[] = []
    for (let i = 0; i <= 10; i++) {
      points.push(new Vector2(Math.sin(i * 0.2) * 0.5 + 0.3, i * 0.1))
    }
    super(position, mesh(new LatheGeometry(points, 12)), 'Lathe')
  }
}

export class OctahedronPrimitive extends Primitive {
  constructor(position: Vector3) {
    super(position, mesh(new OctahedronGeometry()), 'Octahedron')
  }
}

export class PlanePrimitive extends Primitive {
  constructor(position: Vector3, width = 1, height = 1) {
    const geometry = new PlaneGeometry(width, height)
    geometry.rotateX(-Math.PI / 2)
    super(position, mesh(geometry), 'Plane')
  }
}

export class PolyhedronPrimitive extends Primitive {
  constructor(position: Vector3) {
    const vertices = [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1]
    const indices = [2, 1, 0, 0, 3, 2, 1, 3, 0, 2, 3, 1]
    super(position, mesh(new PolyhedronGeometry(vertices, indices, 0.8, 2)), 'Polyhedron')
  }
}

export class RingPrimitive extends Primitive {
  constructor(position: Vector3) {
    super(position, mesh(new RingGeometry(0.5, 1)), 'Ring')
  }
}

export class ShapePrimitive extends Primitive {
  constructor(position: Vector3) {
    const shape = new Shape()
    shape.moveTo(0, 0)
    shape.lineTo(0, 1)
    shape.lineTo(1, 1)
    shape.lineTo(1, 0)
    shape.closePath()
    super(position, mesh(new ShapeGeometry(shape)), 'Shape')
  }
}

export class SpherePrimitive extends Primitive {
  constructor(position: Vector3) {
    super(position, mesh(new SphereGeometry()), 'Sphere')
  }
}

export class TetrahedronPrimitive extends Primitive {
  constructor(position: Vector3) {
    super(position, mesh(new TetrahedronGeometry()), 'Tetrahedron')
  }
}

export class TorusPrimitive extends Primitive {
  constructor(position: Vector3) {
    super(position, mesh(new TorusGeometry()), 'Torus')
  }
}

export class TorusKnotPrimitive extends Primitive {
  constructor(position: Vector3) {
    super(position, mesh(new TorusKnotGeometry()), 'TorusKnot')
  }
}

export class TubePrimitive extends Primitive {
  constructor(position: Vector3) {
    const path = new CatmullRomCurve3([
      new Vector3(-1, 0, 0),
      new Vector3(-0.5, 0.5, 0),
      new Vector3(0.5, -0.5, 0),
      new Vector3(1, 0, 0),
    ])
    super(position, mesh(new TubeGeometry(path, 20, 0.2, 8, false)), 'Tube')
  }
}

export class WireframePrimitive extends Primitive {
  constructor(position: Vector3) {
    super(position, lines(new WireframeGeometry(new BoxGeometry())), 'Wireframe')
  }
}

export const PRIMITIVE_REGISTRY: Record<string, new (position: Vector3) => Primitive> = {
  Box: BoxPrimitive,
  Capsule: CapsulePrimitive,
  Circle: CirclePrimitive,
  Cone: ConePrimitive,
  Cylinder: CylinderPrimitive,
  Dodecahedron: DodecahedronPrimitive,
  Edges: EdgesPrimitive,
  Extrude: ExtrudePrimitive,
  Icosahedron: IcosahedronPrimitive,
  Lathe: LathePrimitive,
  Octahedron: OctahedronPrimitive,
  Plane: PlanePrimitive,
  Polyhedron: PolyhedronPrimitive,
  Ring: RingPrimitive,
  Shape: ShapePrimitive,
  Sphere: SpherePrimitive,
  Tetrahedron: TetrahedronPrimitive,
  Torus: TorusPrimitive,
  TorusKnot: TorusKnotPrimitive,
  Tube: TubePrimitive,
  Wireframe: WireframePrimitive,
}
