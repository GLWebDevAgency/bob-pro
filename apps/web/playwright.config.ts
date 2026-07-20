import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.e2e\.ts/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 4 * 60_000,
  globalTimeout: 14 * 60_000,
  outputDir: 'test-results/cabinet-staging',
  // Aucun report HTML/JUnit n'est persisté : une erreur de navigation d'auth pourrait
  // autrement recopier une URL bearer dans un artefact CI. Le log GitHub masque les secrets.
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.CABINET_WEB_BASE_URL ?? 'https://cabinet-staging.invalid',
    ignoreHTTPSErrors: false,
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
});
