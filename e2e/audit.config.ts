import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

// Playwright's automatic failure prompt can include live form/OTP DOM data.
// Disable the automatic DOM snapshot. Playwright may still emit an error-context
// file from assertion/source text; the collector removes that file before export.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

// Deliberately no dotenv, webServer reuse, or production default.
if (process.env.AUDIT_STACK !== 'true' || process.env.E2E_BASE_URL !== 'http://web'
    || process.env.DB_HOST !== 'postgres' || process.env.REDIS_HOST !== 'redis'
    || !/^audit_[a-z0-9_]+$/.test(process.env.DB_NAME ?? '')) {
    throw new Error('Audit requires the disposable internal Docker stack');
}
export default defineConfig({
    testDir: './audit', outputDir: './artifacts/audit/results',
    workers: 1, fullyParallel: false, retries: 0, forbidOnly: true,
    timeout: 120_000, globalTimeout: 1_200_000, expect: { timeout: 15_000 },
    reporter: [['list'], ['json', { outputFile: resolve(__dirname, 'artifacts/audit/summary.json') }]],
    use: {
        baseURL: 'http://web', locale: 'ko-KR', timezoneId: 'Asia/Seoul',
        viewport: { width: 1440, height: 900 }, actionTimeout: 15_000,
        trace: 'off', video: 'off', screenshot: 'off',
        // Production HTTPS provides WebCrypto. This single internal test origin
        // receives secure-context APIs; TLS/certificate validation is not tested here.
        // Do not disable map hashes, replay signatures, authentication or Origin checks.
        launchOptions: { args: ['--mute-audio', '--unsafely-treat-insecure-origin-as-secure=http://web'] },
    },
    projects: [{ name: 'chromium', use: { browserName: 'chromium', channel: 'chromium' } }],
});
