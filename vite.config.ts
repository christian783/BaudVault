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
    include: ['src/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.tsx'],
    environment: 'node',
    // Engine tickets (BV-04 to BV-07) add the first real suites.
    passWithNoTests: true,
  },
})