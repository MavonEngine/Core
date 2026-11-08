import { describe, expect, it } from 'vitest'
import Player from '../../../src/Networking/Entities/Player'

class TestPlayer extends Player {
  health = 100
  maxHealth = 100
  takeDamage(_amount: number): void { }
  heal(_amount: number): void { }
  update(_delta: number): void { }
}

function withPeer(overrides: Record<string, unknown> = {}) {
  const player = new TestPlayer('p1')
  player.channel = { webrtcConnection: { peerConnection: {
    rtt: () => 35,
    bytesSent: () => 5000,
    bytesReceived: () => 700,
    getSelectedCandidatePair: () => ({ remote: { address: '198.51.100.4' } }),
    ...overrides,
  } } } as any
  return player
}

describe('player', () => {
  it('uses the id as the display name until one is set', () => {
    const player = new TestPlayer('p1')
    expect(player.displayName).toBe('p1')

    player.setDisplayName('Alice')
    expect(player.displayName).toBe('Alice')

    player.setDisplayName(null)
    expect(player.displayName).toBe('p1')
  })

  it('has no connection without a channel', () => {
    expect(new TestPlayer('bot').connection).toBeNull()
  })

  it('reads its connection from the peer connection', () => {
    expect(withPeer().connection).toEqual({
      address: '198.51.100.4',
      rttMs: 35,
      bytesSent: 5000,
      bytesReceived: 700,
    })
  })

  it('leaves out what the peer connection does not know yet', () => {
    const player = withPeer({ rtt: () => -1, getSelectedCandidatePair: () => null })
    expect(player.connection).toMatchObject({ address: null, rttMs: null })
  })

  it('survives a closed peer connection', () => {
    const player = withPeer({
      rtt: () => {
        throw new Error('closed')
      },
    })
    expect(player.connection).toEqual({ address: null, rttMs: null, bytesSent: 0, bytesReceived: 0 })
  })
})
