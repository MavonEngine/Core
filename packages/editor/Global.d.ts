/// <reference types="vite/client" />
import type Game from '@mavonengine/core/Game'

declare global {
  interface Window {
    Game: Game
  }
}

declare module '*.css' {
  const styles: Record<string, string>
  export default styles
}

declare module '*.module.css' {
  const styles: Record<string, string>
  export default styles
}

export {}
