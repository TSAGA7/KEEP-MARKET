/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// База URL для GitHub Pages: https://<user>.github.io/<repo>/ → "/<repo>/".
// Задаётся через VITE_BASE_PATH (в CI — автоматически из имени репозитория).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const base = env.VITE_BASE_PATH || '/';
  return {
    base,
    plugins: [react()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        // Общий доменный код (статусы, схемы, расчёты) — единый для frontend и Edge Functions
        '@shared': fileURLToPath(new URL('./supabase/functions/_shared/domain', import.meta.url)),
      },
    },
    server: { port: 5173, host: true },
    build: { target: 'es2020', sourcemap: false, chunkSizeWarningLimit: 900 },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
      testTimeout: 60000,
      hookTimeout: 60000,
      pool: 'forks',
    },
  };
});
