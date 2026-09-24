import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { configDefaults } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Firestore rules tests need a running emulator and a node environment;
    // they're run separately via `npm run test:rules`.
    exclude: [...configDefaults.exclude, 'firestore/**'],
  },
})
