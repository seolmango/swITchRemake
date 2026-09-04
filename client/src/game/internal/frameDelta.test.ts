import { describe, expect, it } from 'vitest';
import { boundFrameDelta, MAX_FRAME_DELTA_MS } from './frameDelta.ts';

describe('frame delta', () => {
    it('백그라운드 복귀 뒤의 큰 delta를 한 프레임 상한으로 자른다', () => {
        expect(boundFrameDelta(60_000)).toBe(MAX_FRAME_DELTA_MS);
    });

    it('정상 프레임과 멈춘 모션에서도 흐를 수명 시계를 위한 delta는 그대로 둔다', () => {
        expect(boundFrameDelta(1000 / 60)).toBe(1000 / 60);
    });
});
