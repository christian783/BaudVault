import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { offlineServiceWorker } from './scripts/sw-plugin.ts'

// https://vite.dev/config/
export default defineConfig({
  // offlineServiceWorker emits dist/sw.js for offline use (Requirements 8.3, 8.8).
  plugins: [react(), tailwindcss(), offlineServiceWorker()],
  build: {
    // The modulepreload polyfill adds a network request to the bundle. Every
    // supported browser preloads modules natively (Requirement 8.7).
    modulePreload: { polyfill: false },
  },
  test: {
    environment: 'node',
    // Replaces every network API with a stub that throws (Requirement 8.1).
    // Projects inherit it through `extends: true`.
    setupFiles: ['./test/no-network.setup.ts'],
    // Engine tickets (BV-04 to BV-07) add the first real suites.
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.tsx', 'test/**/*.test.ts'],
          exclude: ['src/**/*.bench.test.ts'],
          sequence: { groupOrder: 0 },
        },
      },
      {
        // Speed tests measure wall time, so they run alone after the unit
        // project finishes and never compete with other files for the CPU.
        extends: true,
        test: {
          name: 'bench',
          include: ['src/**/*.bench.test.ts'],
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
})
