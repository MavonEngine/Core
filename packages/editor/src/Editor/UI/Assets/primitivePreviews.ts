import type { BufferGeometry } from 'three'
import { buildPrimitiveGeometry, PRIMITIVE_DEFINITIONS, resolveParams } from '@mavonengine/core/Prefab/Primitives/definitions'
import {
  AmbientLight,
  Box3,
  DirectionalLight,
  DoubleSide,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector3,
} from 'three'
import { withPreviewRenderer } from './previewRenderer'

/** A three-quarter view from above, so solid shapes show three sides and flat ones aren't seen edge on */
const VIEW = new Vector3(1, 0.8, 1.4).normalize()

let cache: Map<string, string> | undefined

/**
 * Small images of every built-in primitive for the Assets panel, as data URLs by primitive name.
 *
 * Rendered once on first use with their default params, then cached; the WebGL context is released
 * straight after, so the panel doesn't hold one open next to the game's. Empty when WebGL isn't available.
 */
export function primitivePreviews(): Map<string, string> {
  if (cache)
    return cache
  const images = new Map<string, string>()

  const scene = new Scene()
  scene.add(new AmbientLight(0xFFFFFF, 0.6))
  const key = new DirectionalLight(0xFFFFFF, 2.2)
  key.position.set(3, 5, 4)
  scene.add(key)
  const rim = new DirectionalLight(0x9DC4FF, 0.8)
  rim.position.set(-4, 2, -3)
  scene.add(rim)

  const camera = new PerspectiveCamera(35, 1, 0.01, 100)
  // Both sides, so open shapes (Lathe, a part circle) look solid when seen from inside
  const meshMaterial = new MeshStandardMaterial({
    color: 0xB8BEC8,
    roughness: 0.55,
    metalness: 0.05,
    side: DoubleSide,
  })
  const lineMaterial = new LineBasicMaterial({ color: 0x4A9EFF })

  withPreviewRenderer((renderer) => {
    for (const [name, definition] of Object.entries(PRIMITIVE_DEFINITIONS)) {
      const geometry: BufferGeometry = buildPrimitiveGeometry(definition, resolveParams(definition))
      const object = 'lines' in definition && definition.lines
        ? new LineSegments(geometry, lineMaterial)
        : new Mesh(geometry, meshMaterial)
      scene.add(object)

      frame(camera, object)
      renderer.render(scene, camera)
      images.set(name, renderer.domElement.toDataURL('image/png'))

      scene.remove(object)
      geometry.dispose()
    }
  })
  meshMaterial.dispose()
  lineMaterial.dispose()

  cache = images
  return images
}

/** Points the camera at the object from VIEW, close enough that it fills most of the image */
function frame(camera: PerspectiveCamera, object: Mesh | LineSegments) {
  const sphere = new Box3().setFromObject(object).getBoundingSphere(new Sphere())
  const distance = sphere.radius / Math.sin((camera.fov * Math.PI / 180) / 2) * 1.05
  camera.position.copy(sphere.center).addScaledVector(VIEW, distance)
  camera.lookAt(sphere.center)
  camera.near = distance / 100
  camera.far = distance * 10
  camera.updateProjectionMatrix()
}
