import type { CommandPacket, ServerCommand } from '../Commands'

export type SV_REMOVE_ENTITY = CommandPacket<ServerCommand.SV_REMOVE_ENTITY> & {
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
