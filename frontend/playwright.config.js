import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 45000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote'],
    } : {},
  },
  projects: [
    { name: 'small-phone', use: { ...devices['Pixel 5'], viewport: { width: 320, height: 568 } } },
    { name: 'phone', use: { ...devices['Pixel 5'] } },
    { name: 'tablet', use: { browserName: 'chromium', viewport: { width: 768, height: 1024 }, hasTouch: true } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
  ],
  webServer: [
    { command: 'node tests/start-api.mjs', url: 'http://127.0.0.1:5100/api/meta/enums', timeout: 30000 },
    { command: 'npm run dev -- --host 0.0.0.0 --port 5174 --strictPort', url: 'http://127.0.0.1:5174', env: { API_PROXY_TARGET: 'http://127.0.0.1:5100' } },
  ],
});
