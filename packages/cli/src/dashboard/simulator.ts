import type { MetricsSource } from './MetricsClient'
import type { ServerMetricsSnapshot } from './snapshot'

const HISTORY_LENGTH = 60

/**
 * Small deterministic PRNG so --sim output is the same every run.
 */
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function push<T>(history: T[], item: T) {
  history.push(item)
  if (history.length > HISTORY_LENGTH)
    history.shift()
}

/**
 * A fake game server, for working on the dashboard without running one.
 * Each fetch advances the simulation by one sample.
 */
export function simulatedSource(seed = 1, sampleIntervalMs = 1000): MetricsSource {
  const random = mulberry32(seed)
  const tickRate = 30
  const budgetMs = Math.round((1000 / tickRate) * 100) / 100

  let step = 0
  let now = Date.UTC(2026, 0, 1)
  let sequence = 0

  const cpuHistory: ServerMetricsSnapshot['cpu']['history'] = []
  const bandwidthHistory: ServerMetricsSnapshot['bandwidth']['history'] = []
  const tickHistory: ServerMetricsSnapshot['tick']['history'] = []

  return {
    label: 'simulation',
    async fetch() {
      step++
      now += sampleIntervalMs
      sequence += tickRate

      // Players drift in and out on a slow wave
      const playerCount = Math.max(1, Math.round(6 + 5 * Math.sin(step / 20) + random() * 2))
      const players = Array.from({ length: playerCount }, (_, i) => ({
        id: `sim-${(i + 1).toString().padStart(2, '0')}`,
        position: {
          x: Math.round(Math.cos(step / 10 + i) * (10 + i * 3) * 100) / 100,
          y: 0,
          z: Math.round(Math.sin(step / 10 + i) * (10 + i * 3) * 100) / 100,
        },
        lastProcessedSequenceId: sequence - Math.floor(random() * 3),
        trackedEntities: playerCount + 20 + Math.floor(random() * 5),
      }))

      const cpu = Math.max(0, 12 + playerCount * 2.5 + Math.sin(step / 7) * 6 + random() * 4)
      push(cpuHistory, { timestamp: now, cpuPercentage: Math.round(cpu * 100) / 100 })

      const sent = Math.round(playerCount * (900 + random() * 300) * tickRate * sampleIntervalMs / 1000)
      const received = Math.round(playerCount * (120 + random() * 60) * tickRate * sampleIntervalMs / 1000)
      push(bandwidthHistory, { timestamp: now, sent, received })

      // Occasional spike so the max line has something to show
      const avgMs = 2 + playerCount * 0.6 + random() * 1.5
      const maxMs = avgMs + random() * 3 + (step % 17 === 0 ? 25 : 0)
      const commandsPerSecond = playerCount * tickRate
      push(tickHistory, {
        timestamp: now,
        ticks: tickRate,
        ticksPerSecond: tickRate - (maxMs > budgetMs ? 1 : 0),
        avgMs: Math.round(avgMs * 100) / 100,
        maxMs: Math.round(maxMs * 100) / 100,
        commandsPerSecond,
        maxCommandsPerTick: playerCount + Math.floor(random() * 3),
      })

      const average = (ms: number) => {
        const recent = cpuHistory.slice(-Math.max(1, Math.round(ms / sampleIntervalMs)))
        return Math.round(recent.reduce((acc, h) => acc + h.cpuPercentage, 0) / recent.length * 100) / 100
      }

      const heapUsed = 60e6 + playerCount * 2e6 + (step % 30) * 1e6

      const snapshot: ServerMetricsSnapshot = {
        schemaVersion: 1,
        engineVersion: 'simulated',
        serverTime: new Date(now).toISOString(),
        uptime: Math.round(step * sampleIntervalMs / 1000),
        sampleIntervalMs,
        tickRate,
        players,
        world: { entities: playerCount + 140 },
        physics: { bodies: playerCount + 120, colliders: playerCount + 180 },
        cpu: {
          current: cpuHistory.at(-1)!.cpuPercentage,
          avg1s: average(1000),
          avg10s: average(10000),
          avg60s: average(60000),
          history: [...cpuHistory],
        },
        bandwidth: {
          sentPerSecond: Math.round(sent * 1000 / sampleIntervalMs),
          receivedPerSecond: Math.round(received * 1000 / sampleIntervalMs),
          history: [...bandwidthHistory],
        },
        tick: {
          budgetMs,
          latest: tickHistory.at(-1)!,
          history: [...tickHistory],
        },
        memory: {
          rss: heapUsed + 80e6,
          heapUsed,
          heapTotal: heapUsed + 30e6,
          external: 5e6,
        },
        latencySimulation: null,
      }

      return snapshot
    },
  }
}
