import { describe, expect, it } from 'vitest';
import { directionFromOffset, slotFromOffset } from './touchInput.ts';

describe('directionFromOffset', () => {
    it('중립 구역에서는 아무 방향도 아니다', () => {
        // 손가락을 얹어 두기만 한 상태가 이동이 되면 안 된다.
        expect(directionFromOffset(0, 0, 20)).toEqual({ left: false, right: false, up: false, down: false });
        expect(directionFromOffset(12, 12, 20)).toEqual({ left: false, right: false, up: false, down: false });
    });

    it('네 정방향을 화면 좌표 기준으로 낸다', () => {
        // dy는 아래가 양수다. 여기가 뒤집히면 조이스틱을 위로 밀었는데 아래로 간다.
        expect(directionFromOffset(0, -50, 20)).toMatchObject({ up: true, down: false });
        expect(directionFromOffset(0, 50, 20)).toMatchObject({ down: true, up: false });
        expect(directionFromOffset(-50, 0, 20)).toMatchObject({ left: true, right: false });
        expect(directionFromOffset(50, 0, 20)).toMatchObject({ right: true, left: false });
    });

    it('대각선은 두 비트를 함께 세운다', () => {
        expect(directionFromOffset(40, -40, 20)).toMatchObject({ up: true, right: true, down: false, left: false });
        expect(directionFromOffset(-40, 40, 20)).toMatchObject({ down: true, left: true, up: false, right: false });
    });

    it('마주 보는 두 비트가 동시에 서지 않는다', () => {
        // 서버는 left+right를 서로 상쇄시킨다. 그런 입력을 만들면 미는데 안 움직인다.
        for (let degrees = 0; degrees < 360; degrees += 3) {
            const radians = (degrees * Math.PI) / 180;
            const d = directionFromOffset(Math.cos(radians) * 60, Math.sin(radians) * 60, 20);
            expect(d.left && d.right).toBe(false);
            expect(d.up && d.down).toBe(false);
        }
    });
});

describe('slotFromOffset', () => {
    it('12시가 1번이고 시계방향으로 늘어난다', () => {
        // 이모지 휠의 배치와 같아야 한다. 같은 손동작이 화면에 따라 다른 것을 고르면 안 된다.
        expect(slotFromOffset(0, -60, 20, 8)).toBe(1);
        expect(slotFromOffset(60, 0, 20, 8)).toBe(3);
        expect(slotFromOffset(0, 60, 20, 8)).toBe(5);
        expect(slotFromOffset(-60, 0, 20, 8)).toBe(7);
    });

    it('중립이면 고르지 않는다', () => {
        // 열었다가 마음이 바뀌면 가운데로 되돌려 취소할 수 있어야 한다.
        expect(slotFromOffset(5, 5, 20, 8)).toBeNull();
    });

    it('모든 각도가 1..slots 안에 든다', () => {
        for (let degrees = 0; degrees < 360; degrees += 1) {
            const radians = (degrees * Math.PI) / 180;
            const slot = slotFromOffset(Math.cos(radians) * 60, Math.sin(radians) * 60, 20, 8);
            expect(slot).toBeGreaterThanOrEqual(1);
            expect(slot).toBeLessThanOrEqual(8);
        }
    });
});
