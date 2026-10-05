/// <reference lib="webworker" />
// 스위치 충전(작업 증명)을 메인 스레드 밖에서 돈다. 화면은 그동안 계속 반응한다.
import { searchPow } from 'shared';

const STEP = 20_000;

self.onmessage = (event: MessageEvent<{ nonce: string; bits: number }>) => {
    const { nonce, bits } = event.data;
    for (let start = 0; ; start += STEP) {
        const found = searchPow(nonce, bits, start, STEP);
        if (found !== null) {
            self.postMessage({ kind: 'done', counter: found });
            return;
        }
        self.postMessage({ kind: 'progress', tried: start + STEP });
    }
};
