import type { CommandPacket } from '../Commands'
import { ServerCommand } from '../Commands'

export type SV_REMOVE_ENTITY = CommandPacket<ServerCommand.SV_REMOVE_ENTITY> & {
  id: string
}

export type SV_CHAT = {
  playerId: string
  playerName: string
  message: string
}

export type SV_TREES = {
  positions: number[]
  rotations: number[]
  scales: number[]
}
