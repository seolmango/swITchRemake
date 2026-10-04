import { defineConfig } from '@playwright/test';
if (process.env.AUDIT_LIVE_ONCE !== 'owner-authorized-2026-10-04') throw new Error('One-off live audit must be explicitly enabled; never run in CI');
if (process.env.CI) throw new Error('Azure access is prohibited in CI');
export default defineConfig({ testDir: './oneoff', workers: 1, retries: 0,
    timeout: 420_000, globalTimeout: 600_000, expect: { timeout: 20_000 }, reporter: [['list']],
    outputDir: './artifacts/independent-azure',
    use: { baseURL: 'https://switch-dev-193234.koreacentral.cloudapp.azure.com',
        locale: 'ko-KR', viewport: { width: 1440, height: 900 }, actionTimeout: 15_000,
        trace: 'off', screenshot: 'off', video: 'off', launchOptions: { args: ['--mute-audio'] } } });
