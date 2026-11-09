import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type GameServerClient from './GameServerClient'
import { z } from 'zod'
import { READ_ONLY, run } from './result'

const clientId = z.string().optional().describe('Tab id from list_clients. Default: the only open tab, or the only one not running the editor')

const packetFilters = {
  kind: z.enum(['packet', 'event']).optional().describe('packet: messages on the wire. event: connect, disconnect, sync_enter, sync_leave, dropped, state_gap…'),
  direction: z.enum(['in', 'out']).optional().describe('Seen from the side that recorded it: out was sent, in was received'),
  type: z.string().optional().describe('Message or event name, e.g. sv_state or command. Several separated by commas'),
  afterId: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(2000).default(50).describe('Newest records kept when more match'),
}

interface NetRecord { id: number, timestamp: number, kind: string, type: string, direction?: string, peer?: string, [key: string]: unknown }

function withTime<T extends { timestamp: number }>({ timestamp, ...record }: T) {
  return { ...record, time: new Date(timestamp).toISOString() }
}

function listing(list: { enabled?: boolean, latestId: number, matched: number, records: NetRecord[] }) {
  return {
    latestId: list.latestId,
    matched: list.matched,
    records: list.records.map(withTime),
    ...(list.enabled === false ? { note: 'Nothing is being recorded on this side' } : {}),
  }
}

/**
 * Server and client records in one list by time. Both clocks are epoch ms, so in dev on one machine they line up;
 * across machines the two sides are off by their clock difference.
 */
export function mergeTimeline(server: NetRecord[], client: NetRecord[]) {
  return [
    ...server.map(record => ({ side: 'server' as const, ...record })),
    ...client.map(record => ({ side: 'client' as const, ...record })),
  ].sort((a, b) => a.timestamp - b.timestamp || (a.side === b.side ? a.id - b.id : a.side === 'server' ? -1 : 1))
}

export function registerNetworkTools(server: McpServer, client: GameServerClient) {
  server.registerTool('network_packets', {
    title: 'Packets on the server',
    description: 'Packets the game server sent and received and its network events, oldest first: time, direction, message name, '
      + 'client (peer), size in bytes, server tick, input sequence id and a few facts about the payload (entity count, ack, command). '
      + 'The server keeps the last 2000. Pass the returned latestId as afterId to get only newer ones; network_packet shows a payload. '
      + 'Development only.',
    inputSchema: { ...packetFilters, peer: z.string().optional().describe('Only one client: its player id (list_players, or playerId from list_clients)') },
    annotations: READ_ONLY,
  }, ({ afterId, ...query }) => run(async () => listing(await client.packets({ ...query, after: afterId }))))

  server.registerTool('network_packet', {
    title: 'One packet on the server',
    description: 'One record from network_packets with its payload, as it was serialized for the wire. Payloads of old records are '
      + 'dropped to bound memory (hasPayload false). Development only.',
    inputSchema: { id: z.number().int().min(1) },
    annotations: READ_ONLY,
  }, ({ id }) => run(async () => {
    const { record } = await client.packet(id)
    if (!record)
      throw new Error(`No record ${id}: it is older than the 2000 the server keeps, or was never recorded`)
    return withTime(record)
  }))

  server.registerTool('network_sync', {
    title: 'State sync',
    description: 'Who is sent what: the current server tick, the sync distance, each player with the entities in its last state update '
      + '(tracked), its last acknowledged input and the size of that update; and each synced entity with how many players track it '
      + '(trackedBy, 0 means no player is in range), whether it changed since it was last synced and the tick it was last sent in. '
      + 'For entities that do not show up or stop updating on a client. Development only.',
    inputSchema: {
      player: z.string().optional().describe('Only this player, and the entities with `tracked` telling whether it is sent them'),
      includeEntities: z.boolean().default(true),
    },
    annotations: READ_ONLY,
  }, ({ player, includeEntities }) => run(async () => {
    const sync = await client.sync()
    const { entities = [], players = [], ...rest } = sync

    if (!player)
      return includeEntities ? sync : { ...rest, players, entityCount: entities.length }

    const one = players.find((p: { id: string }) => p.id === player)
    if (!one)
      throw new Error(`No player "${player}". Players: ${players.map((p: { id: string }) => p.id).join(', ') || 'none'}`)

    const tracked = new Set<string>(one.tracked)
    return {
      ...rest,
      player: one,
      ...(includeEntities
        ? { entities: entities.map((entity: { id: string }) => ({ ...entity, tracked: tracked.has(entity.id) })) }
        : { entityCount: entities.length }),
    }
  }))

  server.registerTool('client_packets', {
    title: 'Packets on a client',
    description: 'Packets a tab sent and received and its network events (connect, disconnect, state_gap for lost state updates, '
      + 'state_out_of_order), in the same shape as network_packets. Recorded since the tab loaded, the last 2000.',
    inputSchema: { clientId, ...packetFilters },
    annotations: READ_ONLY,
  }, ({ clientId, afterId, ...query }) => run(async () => listing(await client.client('packets', { ...query, after: afterId }, clientId))))

  server.registerTool('client_packet', {
    title: 'One packet on a client',
    description: 'One record from client_packets with its payload.',
    inputSchema: { id: z.number().int().min(1), clientId },
    annotations: READ_ONLY,
  }, ({ id, clientId }) => run(async () => {
    const { record } = await client.client('packet', { id }, clientId)
    if (!record)
      throw new Error(`No record ${id}: it is older than the 2000 the tab keeps, or was never recorded`)
    return withTime(record)
  }))

  server.registerTool('network_timeline', {
    title: 'Network timeline of one client',
    description: 'What happened between the server and one tab, in order of time: the server\'s records for that client and the '
      + 'tab\'s own, merged, each marked with its side. Shows a packet leaving one side and arriving on the other (or not), inputs '
      + 'against the state updates that acknowledge them, and events like sync_enter / sync_leave, dropped and state_gap. '
      + 'Needs the server in development too.',
    inputSchema: {
      clientId,
      sinceMs: z.number().int().min(100).max(600000).default(5000).describe('How far back to look'),
      includePings: z.boolean().default(false).describe('Keep ping / pong, one pair per second'),
      eventsOnly: z.boolean().default(false).describe('Leave the packets out'),
      limit: z.number().int().min(1).max(2000).default(200).describe('Newest entries kept when more match'),
    },
    annotations: READ_ONLY,
  }, ({ clientId, sinceMs, includePings, eventsOnly, limit }) => run(async () => {
    const { network } = await client.client('network', {}, clientId)
    if (!network?.playerId)
      throw new Error('This tab is not connected to the game server, so the server has no records for it')

    const kind = eventsOnly ? 'event' as const : undefined
    const [onServer, onClient] = await Promise.all([
      client.packets({ peer: network.playerId, kind, limit: 2000 }),
      client.client('packets', { kind, limit: 2000 }, clientId),
    ])

    const from = Date.now() - sinceMs
    const entries = mergeTimeline(onServer.records, onClient.records)
      .filter(record => record.timestamp >= from && (includePings || (record.type !== 'ping' && record.type !== 'pong')))

    return {
      playerId: network.playerId,
      pingMs: network.pingMs,
      matched: entries.length,
      entries: entries.slice(-limit).map(withTime),
      note: 'Times are each side\'s own clock. On one machine they line up; otherwise shift one side by the clock difference',
    }
  }))
}
