import {
  ServerCommand as BaseServerCommand,
  CommandPacket,
} from "@mavonengine/core/Networking/Server/Commands"

/**
 * Define all available server commands here that get sent to the client.
 */
export enum LocalServerCommand {
  SV_CHAT = 'sv_chat',
  SV_TREES = 'sv_trees',
}

export const ServerCommand = {
  ...LocalServerCommand,
  ...BaseServerCommand
}

/**
 * Define the structure of the packets below for your defined packet names above
 */
export type SV_REMOVE_ENTITY = CommandPacket<BaseServerCommand.SV_REMOVE_ENTITY> & {
  id: string
}

export interface SV_CHAT {
  playerId: string
  playerName: string
  message: string
}

export interface SV_TREES {
  positions: number[]
  rotations: number[]
  scales: number[]
}
