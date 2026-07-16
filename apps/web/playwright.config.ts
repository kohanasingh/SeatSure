import { defineConfig } from '@playwright/test';

// Assumes the stack is already running (docker compose up -d && pnpm dev),
// same as the quickstart. CI starts the built servers before this suite.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
  },
});
