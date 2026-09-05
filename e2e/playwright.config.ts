import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

loadEnv({ path: resolve(__dirname, '..', '.env'), quiet: true });

const BASE_URL = process.env.E2E_BASE_URL?.trim() || 'http://localhost:5173';
/** 다른 창이 5173을 쓰고 있을 때 `E2E_BASE_URL`로 옆 포트를 잡을 수 있어야 한다. */
const CLIENT_PORT = new URL(BASE_URL).port || '5173';

export default defineConfig({
    testDir: './tests',
    /*
     * 흐름마다 끝에서 스스로 탈퇴하지만, 중간에 실패하면 그 계정이 남는다. 쌓이면 운영자
     * 화면의 "활성 계정" 숫자가 거짓말이 된다.
     */
    globalTeardown: './support/global-teardown.ts',
    outputDir: './artifacts/runs',
    /**
     * 순서대로 돈다.
     *
     * 병렬로 돌리면 빨라지지만 이 점검이 잡으려는 버그가 사라진다 — 방 배정, 활성 방 예약,
     * 인게임 서버 한 대에 방이 몰릴 때의 상한처럼 **전역 상태를 만지는 것들**이라
     * 서로가 서로를 흔들면 무엇이 깨진 건지 알 수 없게 된다.
     */
    workers: 1,
    fullyParallel: false,
    forbidOnly: Boolean(process.env.CI),
    // 재시도하지 않는다. 흔들리는 점검은 통과해도 정보가 없다 — 흔들린다는 사실이 결과다.
    retries: 0,
    timeout: 90_000,
    expect: { timeout: 15_000 },
    reporter: [
        ['./support/summary-reporter.ts'],
        ['html', { outputFolder: './artifacts/report', open: 'never' }],
    ],
    use: {
        baseURL: BASE_URL,
        locale: 'ko-KR',
        timezoneId: 'Asia/Seoul',
        actionTimeout: 15_000,
        // 통과한 흐름은 아무것도 남기지 않는다. 실패한 것만 나중에 볼 수 있으면 된다.
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
        // 1920x1080 설계 캔버스를 그대로 담는다. 작게 잡으면 전체가 축소돼 클릭 좌표가 흔들린다.
        viewport: { width: 1920, height: 1080 },
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } } },
    ],
    /**
     * 이미 떠 있으면 그대로 쓴다. 개발 중에 서버를 띄워 둔 채로 점검을 돌리는 것이 보통이고,
     * 그때마다 서버를 죽였다 살리면 방금 재현하던 상태가 사라진다.
     *
     * Postgres와 Redis는 여기서 안 띄운다 — `npm run db:up`이 하는 일이고, 컨테이너를
     * 점검이 껐다 켜면 남의 데이터를 날릴 수 있다.
     */
    webServer: [
        {
            command: 'npm run start -w server-match',
            url: 'http://localhost:3000/health',
            cwd: resolve(__dirname, '..'),
            reuseExistingServer: true,
            timeout: 120_000,
            stdout: 'ignore',
            stderr: 'pipe',
            /*
             * 한 IP에서 수십 개의 계정을 만들고 지운다. 인증 메일 요청이 IP당 분당 5회라
             * 그대로는 흐름이 끝까지 가지 못한다 — 한도를 넓히되 가드는 그대로 돈다.
             *
             * **이미 떠 있는 매칭 서버를 재사용하면 이 값은 안 먹는다.** 그럴 때는 서버를 띄울 때
             * 직접 넣어야 한다: `RATE_LIMIT_RELAXED=true npm run match:dev`
             */
            env: { ...process.env, RATE_LIMIT_RELAXED: 'true' } as Record<string, string>,
        },
        {
            command: 'npm run cluster:start',
            url: 'http://localhost:4100/healthz',
            cwd: resolve(__dirname, '..'),
            reuseExistingServer: true,
            timeout: 180_000,
            stdout: 'ignore',
            stderr: 'pipe',
        },
        {
            /*
             * `--host 127.0.0.1`이 필요하다. Vite는 기본으로 `localhost`에 묶는데 이 환경에서는
             * 그것이 IPv6(`[::1]`)만 잡는다. Playwright 본체(Node)는 그 주소로 붙어 서버가 떴다고
             * 판단하지만, **Chromium은 `localhost`를 IPv4로 풀어 ERR_CONNECTION_REFUSED**를 낸다.
             * 그러면 모든 점검이 화면을 못 열고 무더기로 깨지는데, 원인이 제품처럼 보인다.
             */
            command: `npm run dev -w client -- --port ${CLIENT_PORT} --strictPort --host 127.0.0.1`,
            url: BASE_URL,
            cwd: resolve(__dirname, '..'),
            reuseExistingServer: true,
            timeout: 120_000,
            stdout: 'ignore',
            stderr: 'pipe',
        },
    ],
});
