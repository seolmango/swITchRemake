import { describe, expect, it } from 'vitest';
import { supportsPortraitMenu } from './responsiveMenu.ts';

describe('portrait menu layout selection', () => {
    it.each(['/', '/login', '/signup', '/reset-password', '/change-password', '/rooms', '/rooms/create', '/rooms/join', '/rooms/example/lobby', '/matches/example/result', '/settings', '/profile'])('makes %s readable in normal document flow', (path) => {
        expect(supportsPortraitMenu(path)).toBe(true);
    });
    it.each(['/how-to-play', '/admin', '/replay'])('keeps %s menus readable around their embedded content', (path) => {
        expect(supportsPortraitMenu(path)).toBe(true);
    });
    it.each(['/game', '/training'])('preserves the playable stage for %s', (path) => {
        expect(supportsPortraitMenu(path)).toBe(false);
    });
});
