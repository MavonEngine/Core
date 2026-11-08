import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const

export const LOG_LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'] as const

export const vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() })

export function json(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

/**
 * Run a tool body, turning a failed request into a tool error the model can read
 */
export async function run(body: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return json(await body())
  }
  catch (err) {
    return { isError: true, content: [{ type: 'text', text: (err as Error).message }] }
  }
}
