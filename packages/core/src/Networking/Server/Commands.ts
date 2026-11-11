import type { ChannelId } from '@geckos.io/client'

export enum ServerCommand {
  SV_PONG = 'sv_pong',
  SV_STATE = 'sv_state',
  SV_REMOVE_ENTITY = 'sv_remove_entity',
}
export enum ClientCommand {
  CL_PING = 'cl_ping',
  /**
   * The client booted the editor. The server removes its player and keeps sending it the world state,
   * so the editor shows the live game without being a player.
   */
  CL_EDITOR = 'cl_editor',
}

export type Command = ClientCommand | ServerCommand

export interface CommandPacket<T extends Command | string> {
  type: T
  sequenceId?: number
}

/**
 * The world as one client should see it, sent every server tick
 */
export interface StatePacket<TEntity = unknown> extends CommandPacket<ServerCommand.SV_STATE> {
  entities: TEntity[]
  /** Number of the server tick this state was taken in. Goes up by one per tick, so a gap means a lost packet */
  tick: number
  /** Epoch ms on the server when the state was taken */
  serverTime: number
  /**
   * Sequence id of the last input of the receiving client that the server processed before this state.
   * Inputs after it are not in this state yet. Null for a client without a player, like the editor.
   */
  ack: number | null
}

export interface IncomingClientCommandPacket<T extends Command> extends CommandPacket<T> {
  playerId: ChannelId
}
