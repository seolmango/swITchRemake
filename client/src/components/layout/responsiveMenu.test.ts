import { describe, expect, it } from 'vitest';
import { forcesLandscape, supportsPortraitMenu } from './responsiveMenu.ts';

describe('portrait menu layout selection', () => {
    it.each(['/', '/login', '/signup', '/reset-password', '/change-password', '/rooms', '/rooms/create', '/rooms/join', '/settings', '/profile'])('makes %s readable in normal document flow', (path) => {
        expect(supportsPortraitMenu(path)).toBe(true);
    });
    it.each(['/how-to-play', '/admin', '/replay'])('keeps %s menus readable around their embedded content', (path) => {
        expect(supportsPortraitMenu(path)).toBe(true);
    });
    it.each(['/game', '/training'])('preserves the playable stage for %s', (path) => {
        expect(supportsPortraitMenu(path)).toBe(false);
    });
    // 대기실에 들어가는 순간부터 결과까지는 세로 폰에서도 가로로 돌려 그린다.
    it.each(['/rooms/example/lobby', '/matches/example/result', '/game', '/training'])('forces landscape from the lobby onward: %s', (path) => {
        expect(forcesLandscape(path)).toBe(true);
        expect(supportsPortraitMenu(path)).toBe(false);
    });
    it.each(['/', '/rooms', '/rooms/join', '/settings', '/replay'])('leaves menu %s in its natural orientation', (path) => {
        expect(forcesLandscape(path)).toBe(false);
    });
    /*
     * 목록에서 빠진 화면이 폰에서 축소돼 버리던 자리. 404는 어느 주소에서도 나올 수 있어서
     * 경로를 미리 적어 둘 수 없다 — 모르는 경로의 기본값이 "읽을 수 있다"여야 한다.
     */
    it.each(['/no-such-page', '/rooms/example/unknown', '/service-status', '/deep/unknown/path'])('defaults unknown route %s to readable flow', (path) => {
        expect(supportsPortraitMenu(path)).toBe(true);
    });
});
