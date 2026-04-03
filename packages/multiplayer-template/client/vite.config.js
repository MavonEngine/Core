import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import config from '@mavonengine/core/vite.config'
import vue from '@vitejs/plugin-vue'

const clientRoot = dirname(fileURLToPath(import.meta.url))
const templateRoot = resolve(clientRoot, '..')
const coreRoot = resolve(clientRoot, '../../core')
const coreSrc = resolve(coreRoot, 'src')
const editorRoot = resolve(clientRoot, '../../editor')
const editorSrc = resolve(editorRoot, 'src/Editor.ts')

export default {
  ...config,
  server: {
    ...config.server,
    fs: {
      allow: [templateRoot, resolve(clientRoot, '../../')],
    },
  },
  plugins: [
    ...config.plugins,
    vue(),
  ],
  resolve: {
    ...config.resolve,
    alias: {
      ...(existsSync(editorSrc) ? { '@mavonengine/editor': editorSrc } : {}),
      ...(existsSync(coreSrc) ? { '@mavonengine/core': coreSrc } : {}),
      '@template/server': resolve(templateRoot, 'server/src'),
    },
    dedupe: ['@mavonengine/core', 'three', 'vue', 'react', 'react-dom', '@dimforge/rapier3d-compat'],
  },
}
