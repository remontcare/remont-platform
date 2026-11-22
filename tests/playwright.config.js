// Browser tests against the local full-stack harness (tests/harness/server.cjs) — never production.
// Start the harness first (it needs a throwaway TEST_DATABASE_URL), then: npx playwright test
// Uses the installed Google Chrome, so no browser download is needed.
const { defineConfig } = require('@playwright/test');
const info = (() => { try { return require('./harness/info.json'); } catch (e) { return {}; } })();

module.exports = defineConfig({
  testDir: '.',
  testMatch: /homepage\.spec\.js$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL || info.web || 'http://127.0.0.1:3400',
    channel: 'chrome',
    headless: true,
    serviceWorkers: 'allow',
  },
  projects: [
    { name: 'desktop-1440', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile-390', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
