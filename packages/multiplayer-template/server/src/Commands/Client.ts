import type {
  CommandPacket,
} from '@mavonengine/core/Networking/Server/Commands'
import {
  ClientCommand as BaseClientCommand,
} from '@mavonengine/core/Networking/Server/Commands'

/**
 * Define all available client commands here that get sent to the server.
 */
export enum LocalClientCommand {
  CL_INIT = 'cl_init',
  CL_MOVE = 'cl_move',
  CL_CHAT = 'cl_chat',
}

export const ClientCommand = {
  ...BaseClientCommand,
  ...LocalClientCommand,
} as const

/**
 * Define the structure of the packets below for your defined packet names above
 */
export type CL_INIT = CommandPacket<LocalClientCommand.CL_INIT> & {
  name: string
}

export type CL_MOVE = CommandPacket<LocalClientCommand.CL_MOVE> & {
  keys: string[]
  yaw: number
}

export type CL_CHAT = CommandPacket<LocalClientCommand.CL_CHAT> & {
  message: string
}
