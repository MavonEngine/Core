import {
  CommandPacket,
  ServerCommand as BaseServerCommand,
  ClientCommand as BaseClientCommand
} from "@mavonengine/core/Networking/Server/Commands"

export enum LocalClientCommand {
  CL_INIT = 'cl_init',
  CL_MOVE = 'cl_move',
  CL_CHAT = 'cl_chat',
}

export type ClientCommand = LocalClientCommand | BaseClientCommand

export enum LocalServerCommand {
  SV_STATE = 'sv_state',
  SV_REMOVE_ENTITY = 'sv_remove_entity',
  SV_CHAT = 'sv_chat',
  SV_TREES = 'sv_trees',
}

export type ServerCommand = LocalServerCommand | BaseServerCommand

export type IncomingCommandPacket = CommandPacket<ServerCommand> & {
  playerId: string
}
