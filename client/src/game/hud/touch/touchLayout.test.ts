import { describe, expect, it } from 'vitest';
import { createDefaultTouchLayout, migrateTouchLayout } from '../../../stores/useSettingsStore.ts';
import { TOUCH_ELEMENT_SIZE, placeElement } from './touchLayout.ts';

describe('touch layout', () => {
    it('carries an old two-joystick layout and its shared scale into every element', () => {
        const layout = migrateTouchLayout(undefined, {
            touchScale: 1.2,
            touchMoveAnchor: { x: 0.2, y: 0.8 },
            touchActionAnchor: { x: 0.9, y: 0.7 },
        });
        expect(layout.move).toEqual({ x: 0.2, y: 0.8, scale: 1.2 });
        expect(layout.action).toEqual({ x: 0.9, y: 0.7, scale: 1.2 });
        // 새로 생긴 요소도 쓰던 크기 그대로 시작한다 — 업데이트 뒤에 갑자기 작아지면 안 된다.
        expect(layout.skill.scale).toBe(1.2);
        expect(layout.mode.scale).toBe(1.2);
    });

    it('fills elements missing from a saved layout with defaults', () => {
        const layout = migrateTouchLayout({ move: { x: 0.3, y: 0.6, scale: 0.8 } }, {});
        expect(layout.move).toEqual({ x: 0.3, y: 0.6, scale: 0.8 });
        expect(layout.action).toEqual(createDefaultTouchLayout().action);
    });

    it('sizes each element by its own scale and keeps it fully on screen', () => {
        const layout = createDefaultTouchLayout();
        layout.skill = { x: 1, y: 0, scale: 1.5 };
        const viewport = { width: 844, height: 390 };
        const skill = placeElement('skill', layout, viewport);
        expect(skill.width).toBeCloseTo(TOUCH_ELEMENT_SIZE.skill.width * 1.5);
        expect(skill.x + skill.width / 2).toBeLessThanOrEqual(viewport.width);
        expect(skill.y - skill.height / 2).toBeGreaterThanOrEqual(0);
        // 다른 요소의 배율은 영향을 받지 않는다.
        expect(placeElement('move', layout, viewport).width).toBe(TOUCH_ELEMENT_SIZE.move.width);
    });
});
