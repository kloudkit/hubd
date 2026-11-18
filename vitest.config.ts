import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*', 'plugins/*'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'plugins/*/server/**'],
      reporter: ['text', 'lcov'],
    },
  },
})
