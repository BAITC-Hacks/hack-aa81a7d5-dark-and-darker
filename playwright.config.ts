import { defineConfig } from '@playwright/test';

if (!process.env.HACKALEM_TEST_DB) throw new Error('Запустите браузерные тесты через npm run test:e2e для изоляции данных.');

export default defineConfig({
  testDir: './frontend/tests',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: { baseURL: 'http://127.0.0.1:5174', browserName: 'chromium', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: [
    {
      command: '.venv/bin/python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8001',
      url: 'http://127.0.0.1:8001/api/health',
      env: { HACKALEM_DB_PATH: process.env.HACKALEM_TEST_DB, OPENAI_API_KEY: '', OPENAI_MODEL: '' },
      reuseExistingServer: false,
    },
    {
      command: 'npm run dev -- --port 5174', url: 'http://127.0.0.1:5174',
      env: { HACKALEM_API_TARGET: 'http://127.0.0.1:8001' }, reuseExistingServer: false,
    },
  ],
});
