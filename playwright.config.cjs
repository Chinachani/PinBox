const { defineConfig, devices } = require('@playwright/test');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

module.exports = defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:8098', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: process.env.CI ? undefined : 'chrome' } },
    { name: 'mobile', use: { ...devices['Pixel 7'], defaultBrowserType: 'chromium', channel: process.env.CI ? undefined : 'chrome' } }
  ],
  webServer: {
    command: `${process.env.CI ? 'python' : '.venv/bin/python'} -m uvicorn main:app --app-dir backend --host 127.0.0.1 --port 8098`,
    url: 'http://127.0.0.1:8098',
    env: { PINBOX_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'pinbox-browser-')) },
    reuseExistingServer: false
  }
});
