import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * swITch의 표준: 사용자 흐름·장애·보안을 실제 브라우저로 확인한다(e2e/README.md).
 *
 * 일회용 검증 스택(`npm run verify`) 안에서만 돈다. 개발 DB나 운영 주소에 대고 돌 수 없게 막아 둔다 —
 * 점검은 계정을 만들고 지우고, 방을 채우고, 서버를 내렸다 올린다.
 */

// Playwright's automatic failure prompt can include live form/OTP DOM data.
// Disable the automatic DOM snapshot. Playwright may still emit an error-context
// file from assertion/source text; the collector removes that file before export.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

// Deliberately no dotenv, webServer reuse, or production default.
if (process.env.AUDIT_STACK !== 'true' || process.env.E2E_BASE_URL !== 'http://web'
    || process.env.DB_HOST !== 'postgres' || process.env.REDIS_HOST !== 'redis'
    || !/^audit_[a-z0-9_]+$/.test(process.env.DB_NAME ?? '')) {
    throw new Error('Browser checks run only inside the disposable verify stack (npm run verify)');
}

export default defineConfig({
    testDir: './specs', outputDir: './artifacts/audit/results',
    // 프로세스 증감은 확장 점검(정기·수동)에서만 돈다. 실행에 몇 분이 걸리고 다른 흐름과 함께 돌 수 없다.
    testIgnore: process.env.AUDIT_MODE === 'extended' ? [] : ['scaling/**'],
    // 순서대로 돈다. 방 배정·활성 방 예약처럼 전역 상태를 만지는 흐름이 서로를 흔들면 무엇이 깨졌는지 알 수 없다.
    workers: 1, fullyParallel: false, retries: 0, forbidOnly: true,
    timeout: 180_000, globalTimeout: 3_600_000, expect: { timeout: 15_000 },
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
