export enum ServerCommand {
  SV_STATE = 'sv_state',
  SV_REMOVE_ENTITY = 'sv_remove_entity',
}

export type CommandPacket<T extends ServerCommand> = {
  cmd: T
  data: unknown
}

export type SV_TEST = CommandPacket<ServerCommand.SV_STATE> & {
  boo: string
}
