import { defineConfig } from '@playwright/test';

// Live diagnostics only: no local servers, account creation, or destructive teardown.
export default defineConfig({
    testDir: './live', workers: 1, retries: 0, timeout: 240_000,
    outputDir: './artifacts/azure-20261004/browser',
    reporter: [['list']],
    use: {
        baseURL: process.env.E2E_BASE_URL || 'https://switch-dev-193234.koreacentral.cloudapp.azure.com',
        locale: 'ko-KR', timezoneId: 'Asia/Seoul',
        actionTimeout: 15_000, navigationTimeout: 30_000,
        launchOptions: { args: ['--mute-audio'] },
        screenshot: 'only-on-failure', trace: 'off',
    },
});
