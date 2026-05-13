import type { ChannelId } from '@geckos.io/client'

export enum ServerCommand {
  SV_PONG = 'sv_pong',
  SV_STATE = 'sv_state',
  SV_REMOVE_ENTITY = 'sv_remove_entity',
}
export enum ClientCommand {
  CL_PING = 'cl_ping',
}

export type Command = ClientCommand | ServerCommand

export interface CommandPacket<T extends Command | string> {
  type: T
  sequenceId: number
}

export interface IncomingClientCommandPacket<T extends Command> extends CommandPacket<T> {
  playerId: ChannelId
}
