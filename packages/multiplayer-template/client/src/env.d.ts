/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent
  export default component
}

declare module '*.glsl' {
  const content: string
  export default content
}

// Engine plugins enabled in mavonengine.json, provided by @mavonengine/core's Vite config
declare module 'virtual:mavonengine/plugins' {
  import type { ClientPlugin, LoadedPlugin } from '@mavonengine/core/Plugins/types'

  const plugins: LoadedPlugin<ClientPlugin>[]
  export default plugins
}
