import type Game from './src/Game'

declare global {
  interface Window {
    Game: Game
  }
}

export {}
