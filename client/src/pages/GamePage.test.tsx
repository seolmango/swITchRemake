// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomState } from 'shared';

const mocks = vi.hoisted(() => ({
    sendInput: vi.fn(),
    session: {
        status: 'connected', roomId: 'local-test', role: 'player', selfId: 1,
        roomState: 'playing', starting: { mapId: 'TrainingGround', gameplay: { simulationHz: 30 } }, started: { startTick: 0 }, ended: null,
        lobby: null, mapBundleHash: 'test-map', gameHttpOrigin: 'http://local-test.invalid',
        trainingPlayers: [], skillRejections: [], cooldowns: null,
    },
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn(), useSearchParams: () => [new URLSearchParams()] }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../game/useGameSession.ts', () => ({ useGameSession: () => mocks.session }));
vi.mock('../game/GameSession.ts', () => ({ gameSession: {
    sendInput: mocks.sendInput, getSnapshot: () => mocks.session,
    subscribeSnapshots: () => () => undefined, subscribeBlinks: () => () => undefined,
    subscribeSkillAreas: () => () => undefined,
    getLatestSnapshot: () => new ArrayBuffer(0), updateHudSnapshot: () => undefined, setTrainingPads: () => undefined,
} }));
vi.mock('../game/index.ts', () => {
    const engine = { whenReady: async () => undefined, map: { load: () => undefined },
        setTrainingPads: () => undefined, applySnapshot: () => ({ tick: 0 }), camera: { follow: () => undefined } };
    return { EngineMode: { Play: 'play' }, SwitchGame: ({ onEngine, trainingHud }: {
        onEngine: (engine: unknown) => void; trainingHud?: { onSettings: () => void };
    }) => {
        React.useEffect(() => { onEngine(engine); return () => onEngine(null); }, [onEngine]);
        return <button onClick={trainingHud?.onSettings}>training.settings</button>;
    } };
});
vi.mock('../game/mapBundle.ts', () => ({ verifiedMapView: async () => ({ view: {}, markers: [] }) }));
vi.mock('../game/hud/GameLoadingOverlay.tsx', () => ({ GameLoadingOverlay: () => null }));
vi.mock('../audio/matchSfx.ts', () => ({ useMatchSfx: () => undefined, matchSfx: { onSnapshot: () => undefined } }));
vi.mock('./SettingsPage.tsx', () => ({ SettingsPage: () => <button>settings.first</button> }));
import { useSettingsStore } from '../stores/useSettingsStore.ts';
import { GamePage } from './GamePage.tsx';

describe('configured movement in the live game page', () => {
    let root: Root;
    let container: HTMLDivElement;
    const press = (code: string, modifiers: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { code, ...modifiers }));
    const release = (code: string, modifiers: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent('keyup', { code, ...modifiers }));
    const poll = async () => {
        await act(async () => vi.advanceTimersByTime(34));
        return mocks.sendInput.mock.calls.at(-1)![0];
    };
    beforeEach(async () => {
        vi.useFakeTimers(); vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        mocks.session.roomState = RoomState.Playing;
        useSettingsStore.getState().resetSettings();
        useSettingsStore.getState().setVolume('master', 0);
        useSettingsStore.getState().setKeyBinding('moveUp', 0, 'Shift+KeyW');
        useSettingsStore.getState().setKeyBinding('moveUp', 1, null);
        container = document.createElement('div'); document.body.append(container); root = createRoot(container);
        await act(async () => root.render(<GamePage />));
    });
    afterEach(async () => {
        await act(async () => root.unmount()); container.remove();
        useSettingsStore.getState().resetSettings(); vi.useRealTimers(); vi.unstubAllGlobals();
    });

    it('moves while the saved modifier chord is held and stops when its modifier is released', async () => {
        press('ShiftLeft', { shiftKey: true }); press('KeyW', { shiftKey: true });
        expect((await poll()).up).toBe(true);
        release('ShiftLeft');
        expect((await poll()).up).toBe(false);
        press('ShiftRight', { shiftKey: true });
        expect((await poll()).up).toBe(true);
        release('KeyW', { shiftKey: true });
        expect((await poll()).up).toBe(false);
    });

    it('requires the configured modifiers and clears held movement when focus is lost', async () => {
        press('KeyW'); expect((await poll()).up).toBe(false);
        press('ShiftLeft', { shiftKey: true }); expect((await poll()).up).toBe(true);
        window.dispatchEvent(new Event('blur')); expect((await poll()).up).toBe(false);
    });

    it('preserves walking while Shift is held for emoji controls', async () => {
        useSettingsStore.getState().setKeyBinding('moveUp', 0, 'KeyW');
        press('KeyW'); press('ShiftLeft', { shiftKey: true });
        expect((await poll()).up).toBe(true);
        release('ShiftLeft'); expect((await poll()).up).toBe(true);
    });

    it('prefers a modifier chord over a bare key assigned to another direction', async () => {
        useSettingsStore.getState().setKeyBinding('moveUp', 0, 'KeyW');
        useSettingsStore.getState().setKeyBinding('moveDown', 0, 'Shift+KeyW');
        press('KeyW'); expect(await poll()).toMatchObject({ up: true, down: false });
        press('ShiftLeft', { shiftKey: true }); expect(await poll()).toMatchObject({ up: false, down: true });
        release('ShiftLeft'); expect(await poll()).toMatchObject({ up: true, down: false });
    });

    it('keeps keyboard focus in training settings and restores it when Escape closes the dialog', async () => {
        await act(async () => root.render(<GamePage training />));
        const opener = container.querySelector<HTMLButtonElement>('button')!;
        opener.focus(); await act(async () => opener.click());
        const dialog = container.querySelector<HTMLElement>('[role=dialog]')!;
        expect(dialog).not.toBeNull();
        expect(dialog.contains(document.activeElement)).toBe(true);
        const last = dialog.querySelectorAll<HTMLButtonElement>('button').item(1);
        last.focus();
        await act(async () => last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
        expect(document.activeElement?.textContent).toBe('settings.first');
        await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        expect(container.querySelector('[role=dialog]')).toBeNull();
        expect(document.activeElement).toBe(opener);
    });
});
