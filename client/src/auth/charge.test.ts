import { describe, expect, it } from 'vitest';
import { verifyPow } from 'shared';
import { chargeSwitch } from './charge.ts';

describe('스위치 충전', () => {
    it('서버가 확인할 수 있는 counter를 찾고 진행률을 1까지 채운다', async () => {
        const seen: number[] = [];
        const counter = await chargeSwitch('unit-nonce', 10, { onProgress: (value) => seen.push(value) });
        expect(verifyPow('unit-nonce', 10, counter)).toBe(true);
        expect(seen.at(-1)).toBe(1);
    });

    it('취소하면 멈춘다', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(chargeSwitch('unit-nonce', 30, { signal: controller.signal })).rejects.toThrow('Charge cancelled');
    });
});
