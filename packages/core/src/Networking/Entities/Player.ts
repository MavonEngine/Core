import type { ServerChannel } from '@geckos.io/server'
import NetworkedLivingActor from '../NetworkedLivingActor'

/**
 * What the transport knows about a player's connection.
 */
export interface PlayerConnectionInfo {
  /** Remote IP of the WebRTC connection, null until ICE picks a candidate pair */
  address: string | null
  /** Round trip time in ms, null until measured */
  rttMs: number | null
  bytesSent: number
  bytesReceived: number
}

/**
 * Base class for connected clients / Players
 */
export default abstract class Player extends NetworkedLivingActor {
  $typeName = 'player'

  trackedEntities = new Set<string>()

  /**
   * Epoch ms the player was created. On the server that is when its client connected.
   */
  connectedAt = Date.now()

  /**
   * The client's channel. Set by the server on connection, undefined for bots and on the client.
   */
  channel?: ServerChannel

  private _lastProcessedSequenceId = 0

  private _displayName: string | null = null

  get lastProcessedSequenceId() {
    return this._lastProcessedSequenceId
  }

  /**
   * Human readable name, shown in tools like the CLI dashboard.
   * Falls back to the id until the game sets one.
   */
  get displayName(): string {
    return this._displayName ?? this.id
  }

  /**
   * Pass null to fall back to the id again.
   */
  setDisplayName(name: string | null) {
    this._displayName = name
  }

  /**
   * Live details of the client's WebRTC connection, null without one.
   */
  get connection(): PlayerConnectionInfo | null {
    const peer = this.channel?.webrtcConnection?.peerConnection
    if (!peer)
      return null

    // node-datachannel throws once the peer connection is closed
    try {
      const rtt = peer.rtt()
      return {
        address: peer.getSelectedCandidatePair()?.remote.address ?? null,
        rttMs: rtt >= 0 ? rtt : null,
        bytesSent: peer.bytesSent(),
        bytesReceived: peer.bytesReceived(),
      }
    }
    catch {
      return { address: null, rttMs: null, bytesSent: 0, bytesReceived: 0 }
    }
  }

  updateLastProcessedSequenceId(sequenceId: number) {
    this._lastProcessedSequenceId = sequenceId
  }

  networkedFieldCallbacks(): Record<string, (value: unknown) => void> {
    return {
      ...super.networkedFieldCallbacks(),
      lastProcessedSequenceId: sequenceId => this._lastProcessedSequenceId = sequenceId as number,
    }
  }

  public serialize() {
    return {
      ...super.serialize(),
      $typeName: this.$typeName,
      lastProcessedSequenceId: this.lastProcessedSequenceId,
    }
  }
}
