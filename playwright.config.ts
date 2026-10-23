import { defineConfig } from '@playwright/test';
declare const process: { env: Record<string, string | undefined> }; // node globals, without @types/node

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: {
    baseURL: process.env.PW_BASE ?? 'http://localhost:4173',
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  webServer: process.env.PW_BASE ? undefined : { command: 'npx vite build && npx vite preview --port 4173 --strictPort', port: 4173, reuseExistingServer: true, timeout: 120_000 },
});
