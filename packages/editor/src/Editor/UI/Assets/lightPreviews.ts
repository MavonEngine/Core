import type { Light } from 'three'
import {
  AmbientLight,
  BoxGeometry,
  CircleGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  LightProbe,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  RectAreaLight,
  Scene,
  SphereGeometry,
  SpotLight,
  Vector3,
} from 'three'
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js'
import { withPreviewRenderer } from './previewRenderer'

/** Where the positioned lights sit: above, to the camera's left and a little towards it, so lit sides face the camera */
const LIGHT_POSITION = new Vector3(-0.3, 3, 2.1)

/**
 * The light each preview shows, by LIGHT_REGISTRY name. Not the editor's light classes, which add themselves
 * to the game: plain three.js lights, set up so the difference between them shows in a 64px tile.
 * An optional marker shows where a positioned light is.
 */
const PREVIEW_LIGHTS: Record<string, () => { light: Light, marker?: Mesh }> = {
  AmbientLight: () => ({
    light: new AmbientLight(0xFFFFFF, 1.6),
  }),
  DirectionalLight: () => ({
    light: directional(false),
  }),
  DirectionalLightShadow: () => ({
    light: directional(true),
  }),
  HemisphereLight: () => ({
    light: new HemisphereLight(0x8EC5FF, 0x8A5A2B, 2.2),
  }),
  LightProbe: () => {
    // A soft environment: cool light from above, warm from below
    const probe = new LightProbe()
    probe.sh.coefficients[0].set(1.3, 1.2, 1.15)
    probe.sh.coefficients[1].set(-0.45, 0.05, 0.75)
    probe.intensity = 1.2
    return { light: probe }
  },
  PointLight: () => point(false),
  PointLightShadow: () => point(true),
  RectAreaLight: () => {
    const light = new RectAreaLight(0xFFFFFF, 14, 1.2, 0.8)
    light.position.set(-0.4, 1.9, 1.4)
    light.lookAt(0, 0.3, 0)
    const marker = new Mesh(new PlaneGeometry(1.2, 0.8), new MeshBasicMaterial({ color: 0xFFFFFF }))
    marker.position.copy(light.position)
    marker.quaternion.copy(light.quaternion)
    return { light, marker }
  },
  SpotLight: () => spot(false),
  SpotLightShadow: () => spot(true),
}

function directional(castShadow: boolean) {
  const light = new DirectionalLight(0xFFFFFF, 3)
  light.position.copy(LIGHT_POSITION)
  light.castShadow = castShadow
  light.shadow.mapSize.set(512, 512)
  light.shadow.camera.left = -2
  light.shadow.camera.right = 2
  light.shadow.camera.top = 2
  light.shadow.camera.bottom = -2
  light.shadow.radius = 3
  return light
}

function point(castShadow: boolean) {
  const light = new PointLight(0xFFE2B0, 14, 0, 2)
  light.position.set(-0.6, 1.4, 1.3)
  light.castShadow = castShadow
  light.shadow.mapSize.set(512, 512)
  return {
    light,
    marker: bulb(light.position),
  }
}

function spot(castShadow: boolean) {
  const light = new SpotLight(0xFFFFFF, 45, 0, Math.PI / 11, 0.4, 2)
  light.position.copy(LIGHT_POSITION)
  light.target.position.set(0, 0, 0)
  light.castShadow = castShadow
  light.shadow.mapSize.set(512, 512)
  return {
    light,
    marker: bulb(light.position),
  }
}

function bulb(position: Vector3) {
  const marker = new Mesh(new SphereGeometry(0.08, 12, 8), new MeshBasicMaterial({ color: 0xFFF3C4 }))
  marker.position.copy(position)
  return marker
}

let cache: Map<string, string> | undefined

/**
 * Small images of every built-in light for the Assets panel, as data URLs by light name: a sphere and a box
 * on a floor, lit by only that light. Rendered once on first use, then cached. Empty when WebGL isn't available.
 */
export function lightPreviews(): Map<string, string> {
  if (cache)
    return cache
  const images = new Map<string, string>()

  RectAreaLightUniformsLib.init()

  const scene = new Scene()
  const surface = new MeshStandardMaterial({ color: 0xC9CDD4, roughness: 0.5 })
  const floorMaterial = new MeshStandardMaterial({
    color: new Color(0x6B7078),
    roughness: 0.9,
  })
  const floor = new Mesh(new CircleGeometry(1.7, 48), floorMaterial)
  floor.rotation.x = -Math.PI / 2
  floor.receiveShadow = true
  const ball = new Mesh(new SphereGeometry(0.55, 32, 16), surface)
  ball.position.set(0.3, 0.55, -0.25)
  ball.castShadow = true
  ball.receiveShadow = true
  const box = new Mesh(new BoxGeometry(0.6, 0.6, 0.6), surface)
  // To the ball's left as the camera sees it, so neither hides the other
  box.position.set(-0.6, 0.3, 0.55)
  box.rotation.y = 0.5
  box.castShadow = true
  box.receiveShadow = true
  scene.add(floor, ball, box)

  const camera = new PerspectiveCamera(35, 1, 0.1, 50)
  camera.position.set(3.6, 3.2, 4.8)
  camera.lookAt(0, 0.25, 0)

  withPreviewRenderer((renderer) => {
    for (const [name, create] of Object.entries(PREVIEW_LIGHTS)) {
      const { light, marker } = create()
      scene.add(light)
      if (light instanceof SpotLight || light instanceof DirectionalLight)
        scene.add(light.target)
      if (marker)
        scene.add(marker)

      renderer.render(scene, camera)
      images.set(name, renderer.domElement.toDataURL('image/png'))

      scene.remove(light)
      if (light instanceof SpotLight || light instanceof DirectionalLight)
        scene.remove(light.target)
      if (marker) {
        scene.remove(marker)
        marker.geometry.dispose()
        ;(marker.material as MeshBasicMaterial).dispose()
      }
      light.dispose()
    }
  }, { shadows: true })

  floor.geometry.dispose()
  ball.geometry.dispose()
  box.geometry.dispose()
  surface.dispose()
  floorMaterial.dispose()

  cache = images
  return images
}
