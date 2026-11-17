import { defineConfig, devices } from '@playwright/test';

const chrome = { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } };

export default defineConfig({
  testDir: 'tests',
  testMatch: /.*\.spec\.mjs$/,
  globalSetup: './tests/global-setup.mjs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: chrome, testIgnore: /performance\.spec\.mjs$/ },
    // Timing measurements run on their own, after everything else, so other
    // browsers competing for the CPU don't show up as main-thread stalls.
    { name: 'performance', use: chrome, testMatch: /performance\.spec\.mjs$/, dependencies: ['chromium'] },
  ],
});
