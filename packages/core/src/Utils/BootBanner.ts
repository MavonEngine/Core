export interface BootBannerInfo {
  version: string
  /** Three.js revision, e.g. '180' */
  threeRevision?: string
  rapierVersion?: string
  mode: string
}

/**
 * The box logged when a game starts. Kept free of imports so tools like @mavonengine/cli can show it
 * without loading the engine.
 */
export function bootBanner({ version, threeRevision, rapierVersion, mode }: BootBannerInfo): string[] {
  const row = (label: string, value: string) => `│  ${`${label}:`.padEnd(10)}${value.padEnd(28)} │`

  return [
    '┌─────────────────────────────────────────┐',
    '│                                         │',
    '│              MavonEngine                │',
    '│                                         │',
    row('Version', version),
    ...(threeRevision ? [row('Three.js', `r${threeRevision}`)] : []),
    ...(rapierVersion ? [row('Rapier', rapierVersion)] : []),
    row('Mode', mode),
    '│                                         │',
    '│  https://github.com/MavonEngine/core    │',
    '│  https://mavonengine.com                │',
    '│                                         │',
    '└─────────────────────────────────────────┘',
  ]
}
