import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { configDefaults } from 'vitest/config'

const FUNCTIONS_EMULATOR_HOST = '127.0.0.1'
const FUNCTIONS_EMULATOR_PORT = 5001
const FUNCTIONS_REGION = 'asia-south1'
const API_FUNCTION_NAME = 'api'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const projectId = env.VITE_FIREBASE_PROJECT_ID

  return {
    plugins: [react(), tailwindcss()],
    server: {
      // Local API transport: proxy /api/* to the Functions emulator.
      // Production uses a Firebase Hosting rewrite instead (see firebase.json).
      proxy: projectId
        ? {
            '/api': {
              target: `http://${FUNCTIONS_EMULATOR_HOST}:${FUNCTIONS_EMULATOR_PORT}/${projectId}/${FUNCTIONS_REGION}/${API_FUNCTION_NAME}`,
              changeOrigin: true,
              rewrite: (path: string) => path.replace(/^\/api/, ''),
            },
          }
        : undefined,
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      // Firestore rules tests and functions emulator tests need a running
      // emulator and a node environment; they're run separately via
      // `npm run test:rules` / `npm run test:functions-emulator`.
      exclude: [...configDefaults.exclude, 'firestore/**', 'functions/src/**/*.emulator.test.ts'],
    },
  }
})
