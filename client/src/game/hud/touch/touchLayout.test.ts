import { describe, expect, it } from 'vitest';
import { anchorFromPoint, placeAnchor } from './touchLayout.ts';

const viewport = { width: 800, height: 400 };

describe('placeAnchor', () => {
    it('컨트롤 전체가 화면 안에 들어오게 가둔다', () => {
        // 선택기가 화면 밖으로 나가면 보이지 않는 칸이 생긴다.
        expect(placeAnchor({ x: 1, y: 1 }, viewport, 120)).toEqual({ x: 680, y: 280 });
        expect(placeAnchor({ x: 0, y: 0 }, viewport, 120)).toEqual({ x: 120, y: 120 });
    });

    it('가둘 필요가 없으면 그대로 둔다', () => {
        expect(placeAnchor({ x: 0.5, y: 0.5 }, viewport, 120)).toEqual({ x: 400, y: 200 });
    });

    it('축마다 따로 판단한다 — 좁은 쪽만 가운데로 간다', () => {
        // reach 300은 가로(800)에는 들어가고 세로(400)에는 안 들어간다. 축을 한꺼번에 판단하면
        // 들어갈 수 있는 축까지 가운데로 밀려 조이스틱이 화면 한복판을 가린다.
        expect(placeAnchor({ x: 0.1, y: 0.1 }, viewport, 300)).toEqual({ x: 300, y: 200 });
    });
});

describe('anchorFromPoint', () => {
    it('화면 좌표를 0~1로 되돌린다', () => {
        expect(anchorFromPoint({ x: 400, y: 100 }, viewport)).toEqual({ x: 0.5, y: 0.25 });
    });

    it('화면 밖으로 끌어도 0~1을 벗어나지 않는다', () => {
        expect(anchorFromPoint({ x: -50, y: 900 }, viewport)).toEqual({ x: 0, y: 1 });
    });
});
