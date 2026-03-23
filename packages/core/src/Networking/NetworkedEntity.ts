export default interface NetworkedEntity {
  $typeName: string
  updateFromNetwork(data: object): void
  previousStateHash: string
  needsSync: boolean
  markSyncd(): void
}
