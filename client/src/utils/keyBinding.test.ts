import { describe, expect, it } from 'vitest';
import { formatKeyBinding, formatKeyBindings } from './keyBinding.ts';

describe('key binding labels', () => {
    it('formats persisted keyboard codes and modifiers', () => {
        expect(formatKeyBinding('KeyW', 'Unassigned')).toBe('W');
        expect(formatKeyBinding('Digit1', 'Unassigned')).toBe('1');
        expect(formatKeyBinding('ArrowUp', 'Unassigned')).toBe('↑');
        expect(formatKeyBinding('Shift+Digit1', 'Unassigned')).toBe('Shift+1');
        expect(formatKeyBinding(null, 'Unassigned')).toBe('Unassigned');
    });

    it('joins both binding slots for HUD labels', () => {
        expect(formatKeyBindings(['KeyW', 'ArrowUp'], 'Unassigned')).toBe('W / ↑');
        expect(formatKeyBindings([null, null], 'Unassigned')).toBe('Unassigned');
    });
});
