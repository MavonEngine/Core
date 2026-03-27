import type { CommandPacket } from '../Commands'
import { ClientCommand } from '../Commands'

export type CL_INIT = CommandPacket<ClientCommand.CL_INIT> & {
  name: string
}

export type CL_MOVE = CommandPacket<ClientCommand.CL_MOVE> & {
  keys: string[]
  yaw: number
}

export type CL_CHAT = CommandPacket<ClientCommand.CL_CHAT> & {
  message: string
}
