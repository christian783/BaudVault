import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // The modulepreload polyfill adds a network request to the bundle. Every
    // supported browser preloads modules natively (Requirement 8.7).
    modulePreload: { polyfill: false },
  },
  test: {
    environment: 'node',
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