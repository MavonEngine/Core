import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The dev inbox tests start MailDev, slow on Windows runners
    testTimeout: 30_000,
  },
})
