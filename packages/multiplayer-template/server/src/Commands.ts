export type Command = ClientCommand | ServerCommand

export enum ClientCommand {
  CL_INIT = 'cl_init',
  CL_MOVE = 'cl_move',
  CL_CHAT = 'cl_chat',
}

export enum ServerCommand {
  SV_STATE = 'sv_state',
  SV_REMOVE_ENTITY = 'sv_remove_entity',
  SV_CHAT = 'sv_chat',
  SV_TREES = 'sv_trees',
}

export interface CommandPacket<T extends Command> {
  type: T
  sequenceId: number
}

export type IncomingCommandPacket = CommandPacket<Command> & {
  playerId: string
}
