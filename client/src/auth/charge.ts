import { searchPow } from 'shared';

/**
 * 스위치 충전. 서버가 준 nonce로 작업 증명을 풀어 counter를 돌려준다.
 *
 * 워커를 쓸 수 있으면 워커에서, 없으면(테스트 환경, 아주 오래된 브라우저) 메인 스레드에서 조금씩
 * 끊어 돈다. 진행률은 확률적이다 — 2^bits번 안에 끝날 기대값으로 채우고, 실제로 찾으면 바로 끝난다.
 */
export interface ChargeOptions {
    onProgress?: (fraction: number) => void;
    signal?: AbortSignal;
}

const expectedFraction = (tried: number, bits: number): number => 1 - Math.exp(-tried / 2 ** bits);

const abortError = () => new DOMException('Charge cancelled', 'AbortError');

export function chargeSwitch(nonce: string, bits: number, options: ChargeOptions = {}): Promise<number> {
    const { onProgress, signal } = options;
    if (signal?.aborted) return Promise.reject(abortError());

    if (typeof Worker !== 'undefined') {
        return new Promise((resolve, reject) => {
            const worker = new Worker(new URL('./chargeWorker.ts', import.meta.url), { type: 'module' });
            const stop = () => { worker.terminate(); reject(abortError()); };
            signal?.addEventListener('abort', stop, { once: true });
            worker.onmessage = (event: MessageEvent<{ kind: 'progress'; tried: number } | { kind: 'done'; counter: number }>) => {
                if (event.data.kind === 'progress') {
                    onProgress?.(expectedFraction(event.data.tried, bits));
                    return;
                }
                signal?.removeEventListener('abort', stop);
                worker.terminate();
                onProgress?.(1);
                resolve(event.data.counter);
            };
            worker.onerror = (error) => {
                signal?.removeEventListener('abort', stop);
                worker.terminate();
                reject(error);
            };
            worker.postMessage({ nonce, bits });
        });
    }

    return (async () => {
        const step = 5_000;
        for (let start = 0; ; start += step) {
            if (signal?.aborted) throw abortError();
            const found = searchPow(nonce, bits, start, step);
            if (found !== null) { onProgress?.(1); return found; }
            onProgress?.(expectedFraction(start + step, bits));
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    })();
}
