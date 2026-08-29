import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** 점검이 남긴 계정을 치운다. 실패해도 점검 결과를 뒤집지 않는다 — 뒷정리는 판정이 아니다. */
export default function globalTeardown(): void {
    try {
        execFileSync(
            process.execPath,
            [resolve(__dirname, '..', '..', 'scripts', 'e2e-cleanup.cjs'), '--apply'],
            { cwd: resolve(__dirname, '..', '..'), stdio: 'pipe' },
        );
    } catch {
        // DB가 안 떠 있거나 권한이 없을 수 있다. 다음에 `npm run e2e:cleanup`으로 치우면 된다.
    }
}
