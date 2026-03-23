export type AssetType = 'cubeTexture' | 'texture' | 'gltfModel' | 'sound' | 'svg' | 'font'

export interface Asset {
  name: string
  type: AssetType
  path: string[] | string
}
