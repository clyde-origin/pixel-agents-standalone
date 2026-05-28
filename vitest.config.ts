import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'webview-ui/src/**/*.test.ts'],
    environment: 'node',
    globals: true,
  },
})
