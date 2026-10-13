/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// База URL для GitHub Pages: https://<user>.github.io/<repo>/ → "/<repo>/".
// Задаётся через VITE_BASE_PATH (в CI — автоматически из имени репозитория).
// Content-Security-Policy добавляется только в production-сборку (dev-сервер Vite использует inline-скрипты)
function cspPlugin(supabaseUrl: string): Plugin {
  const connect = ["'self'", 'https://*.supabase.co', supabaseUrl].filter(Boolean).join(' ');
  const csp = [
    "default-src 'self'",
    "script-src 'self' https://telegram.org",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
  return {
    name: 'keep-market-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const base = env.VITE_BASE_PATH || '/';
  return {
    base,
    plugins: [react(), cspPlugin(env.VITE_SUPABASE_URL ?? '')],
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
