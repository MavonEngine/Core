import process from 'node:process'
import { defineConfig, devices } from '@playwright/test'

const CI = !!process.env.CI

export default defineConfig({
  testDir: './e2e',
  webServer: {
    command: CI
      ? 'npm run preview --prefix ../multiplayer-template/client'
      : 'npm run dev --prefix ../multiplayer-template/client',
    url: CI ? 'http://localhost:4173' : 'http://localhost:5173',
    reuseExistingServer: !CI,
    timeout: 30_000,
  },
  use: {
    baseURL: CI ? 'http://localhost:4173' : 'http://localhost:5173',
    ...devices['Desktop Chrome'],
  },
})
