import type { Vector3 } from 'three'
import type { EmitterPreviewConfig } from './Emitter'
import type ParticleEffect from './ParticleEffect'
import Logger from '../../Utils/Logger'

export interface ParticleRegistryEntry {
  preview: EmitterPreviewConfig
  spawn(position: Vector3): ParticleEffect
}

const registry: Record<string, ParticleRegistryEntry> = {}
// eslint-disable-next-line node/prefer-global/process
const logger = new Logger(process.env.NODE_ENV === 'production' ? 'error' : 'debug')

export function registerParticle(name: string, entry: ParticleRegistryEntry) {
  registry[name] = entry
  logger.info(`Particle registered: ${name}`)
}

export function getPreviewMap(): Record<string, EmitterPreviewConfig> {
  return Object.fromEntries(Object.entries(registry).map(([k, v]) => [k, v.preview]))
}

export function spawnParticle(name: string, position: Vector3): ParticleEffect | null {
  const effect = registry[name]?.spawn(position) ?? null
  if (effect) {
    effect.persistent = true
    effect.registerEditorHelper(position, name, effect)
    effect.emitters.forEach((e) => {
      e.mesh.name = name
      e.mesh.userData.editorHelper = effect.editorHelper
    })
  }
  return effect
}
