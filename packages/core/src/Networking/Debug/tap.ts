import type NetRecorder from './NetRecorder'
import type { NetDirection } from './NetRecorder'

/** Events geckos.io raises on the same emitters as the messages: they never were on the wire */
const TRANSPORT_EVENTS = new Set([
  'connect',
  'connection',
  'dataChannelIsOpen',
  'disconnect',
  'disconnected',
  'dropped',
  'error',
  'receiveFromDataChannel',
  'sendOverDataChannel',
])

const MAX_SEEN_RELIABLE_IDS = 500

const serialized = new WeakMap<object, string>()

/**
 * Tell the tap the JSON of a payload that was serialized already, so it isn't serialized a second time
 */
export function rememberJson(data: object, json: string) {
  serialized.set(data, json)
}

/**
 * Record every message that passes through `target[method]`, called as `(eventName, data)`.
 *
 * The hooks sit inside geckos.io rather than on the public `emit()` / `on()`, so they see the game's own messages
 * however it sends or listens, and leave the channel's public methods as they are:
 * - sent by the server:      `channel._emit`
 * - received by the server:  `channel.eventEmitter.emit`
 * - sent by a client:        `socket.connectionsManager.emit`
 * - received by a client:    `socket.bridge.emit`
 *
 * Does nothing when `target` has no such method, e.g. another transport or a mock.
 */
export function tapMessages(target: unknown, method: string, direction: NetDirection, recorder: NetRecorder, peer?: string) {
  const holder = target as Record<string, unknown> | null | undefined
  const original = holder?.[method]
  if (!holder || typeof original !== 'function')
    return

  const seenReliable = new Set<string>()

  holder[method] = function (this: unknown, ...args: unknown[]) {
    const [eventName, data] = args as [string, unknown]
    if (recorder.enabled && typeof eventName === 'string' && !TRANSPORT_EVENTS.has(eventName)) {
      const wrapped = data as { RELIABLE?: number, ID?: string, MESSAGE?: unknown } | null
      const reliable = !!wrapped && typeof wrapped === 'object' && wrapped.RELIABLE === 1

      if (!reliable) {
        recorder.packet(direction, eventName, data, {
          peer,
          json: data && typeof data === 'object' ? serialized.get(data) : undefined,
        })
      }
      else if (!seenReliable.has(wrapped.ID!)) {
        // A reliable message is sent several times, only the first copy is recorded
        seenReliable.add(wrapped.ID!)
        if (seenReliable.size > MAX_SEEN_RELIABLE_IDS)
          seenReliable.delete(seenReliable.values().next().value!)
        recorder.packet(direction, eventName, wrapped.MESSAGE, { peer, reliable: true })
      }
    }
    return original.apply(this, args)
  }
}
