import { defineConfig, devices } from '@playwright/test'

// E2E-проверка веб-IDE в реальном браузере. По умолчанию бьёт по прод-сборке на :3001
// (бэкенд раздаёт статику). Переопределить адрес: IDE_URL=https://host:port npx playwright test.
const IDE_URL = process.env.IDE_URL || 'http://localhost:3001'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,        // тесты делят серверное состояние сессий — гоняем последовательно
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: IDE_URL,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    ignoreHTTPSErrors: true,   // на случай self-signed (mkcert) при IDE_URL=https
    viewport: { width: 1400, height: 900 },  // десктоп: боковые панели видны без выезжания
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
