export default interface NetworkedEntity {
  $typeName: string
  updateFromNetwork(data: Record<string, unknown>): void
  networkedFieldCallbacks(): Record<string, (value: unknown) => void>
  previousStateHash: string
  needsSync: boolean
  markSyncd(): void
}
