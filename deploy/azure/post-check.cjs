#!/usr/bin/env node
'use strict';
/**
 * 배포 뒤 확인: 공개 주소가 정상이고, 살아 있는 인게임 서버가 이 커밋의 규칙 버전을 말하는가.
 *
 *   node deploy/azure/post-check.cjs https://game.example.com
 *
 * 규칙 버전은 server-game/src/config/rules-lock.ts에서 읽는다. 서버가 새로 뜬 직후에는 heartbeat가
 * 늦을 수 있어 1분 동안 다시 본다.
 */
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!/^https?:\/\/[^/]+$/.test(base)) {
    console.error('사용법: node deploy/azure/post-check.cjs https://공개주소');
    process.exit(2);
}
const lock = readFileSync(resolve(__dirname, '../../server-game/src/config/rules-lock.ts'), 'utf8');
const expected = lock.match(/version:\s*'([^']+)'/)?.[1];
if (!expected) throw new Error('rules-lock.ts에서 버전을 읽지 못했다');

(async () => {
    const deadline = Date.now() + 60_000;
    let last = '';
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${base}/api/health/ready`, { signal: AbortSignal.timeout(10_000) });
            const body = await response.json();
            last = `HTTP ${response.status}, status=${body.status}, rulesVersions=${JSON.stringify(body.rulesVersions ?? [])}`;
            if (response.ok && body.status === 'ready' && Array.isArray(body.rulesVersions) && body.rulesVersions.includes(expected)) {
                console.log(`정상: ${base} 규칙 ${expected}`);
                return;
            }
        } catch (error) {
            last = String(error.message ?? error);
        }
        await new Promise((done) => setTimeout(done, 5_000));
    }
    console.error(`배포 확인 실패: 규칙 ${expected}를 기대했다. 마지막 응답: ${last}`);
    process.exitCode = 1;
})();
