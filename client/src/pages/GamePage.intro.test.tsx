// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomState } from 'shared';

/*
 * 경기 시작 연출(BASE.md §2.8)의 배선. 브라우저 흐름 점검으로 보면 CI에서 화면 준비가 카운트다운보다
 * 오래 걸릴 때 연출이 (규칙대로) 건너뛰어져 흔들린다. 그래서 여기서 결정적으로 고정한다.
 */
const mocks = vi.hoisted(() => ({
    sendInput: vi.fn(),
    engine: {
        whenReady: async () => undefined, map: { load: () => undefined }, setTrainingPads: () => undefined,
        applySnapshot: () => ({ tick: 0 }), camera: { follow: () => undefined },
        playStartIntro: vi.fn(), endStartIntro: vi.fn(),
    },
    session: {} as Record<string, unknown>,
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn(), useSearchParams: () => [new URLSearchParams()] }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../game/useGameSession.ts', () => ({ useGameSession: () => mocks.session }));
vi.mock('../game/GameSession.ts', () => ({ gameSession: {
    sendInput: mocks.sendInput, send: () => true, getSnapshot: () => mocks.session,
    subscribeSnapshots: () => () => undefined, subscribeBlinks: () => () => undefined,
    subscribeSkillAreas: () => () => undefined,
    getLatestSnapshot: () => null, updateHudSnapshot: () => undefined, setTrainingPads: () => undefined,
} }));
vi.mock('../game/index.ts', () => ({ EngineMode: { Play: 'play', Spectate: 'spectate' }, SwitchGame: ({ onEngine }: { onEngine: (engine: unknown) => void }) => {
    React.useEffect(() => { onEngine(mocks.engine); return () => onEngine(null); }, [onEngine]);
    return null;
} }));
vi.mock('../game/mapBundle.ts', () => ({ verifiedMapView: async () => ({ view: {}, markers: [] }) }));
vi.mock('../game/hud/GameLoadingOverlay.tsx', () => ({ GameLoadingOverlay: ({ ready }: { ready: boolean }) => <div data-testid="loading" data-ready={String(ready)}/> }));
vi.mock('./SettingsPage.tsx', () => ({ SettingsPage: () => null }));
vi.mock('../audio/matchSfx.ts', () => ({ useMatchSfx: () => undefined, matchSfx: { onSnapshot: () => undefined } }));
import { GamePage } from './GamePage.tsx';

const COUNTDOWN_MS = 9000;

function countdownSession(spawns?: Array<{ playerId: number; x: number; y: number }>) {
    return {
        status: 'connected', roomId: 'room', role: 'player', selfId: 2,
        roomState: RoomState.Countdown,
        starting: { startsAtTick: 100, countdownMs: COUNTDOWN_MS, mapId: 'Grove', gameplay: { simulationHz: 30 }, ...(spawns ? { spawns } : {}) },
        startingReceivedAt: Date.now(), started: null, ended: null,
        lobby: { players: [
            { playerId: 1, colorIndex: 0, nickname: 'a', role: 'player', skills: [] },
            { playerId: 2, colorIndex: 1, nickname: 'b', role: 'player', skills: [] },
        ] },
        mapBundleHash: 'hash', gameHttpOrigin: 'http://local-test.invalid',
        trainingPlayers: [], skillRejections: [], cooldowns: null, taggerId: null,
    };
}

describe('start intro during the countdown', () => {
    let root: Root;
    let container: HTMLDivElement;
    const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { vi.advanceTimersByTime(20); }); };

    beforeEach(() => {
        vi.useFakeTimers(); vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    });
    afterEach(async () => {
        await act(async () => root.unmount()); container.remove();
        vi.useRealTimers(); vi.unstubAllGlobals();
    });

    it('plays the intro with every start position, lifts the loading cover and sends no movement', async () => {
        mocks.session = countdownSession([{ playerId: 1, x: 384, y: 384 }, { playerId: 2, x: 640, y: 896 }]);
        await act(async () => root.render(<GamePage />));
        await settle();

        expect(mocks.engine.playStartIntro).toHaveBeenCalledTimes(1);
        const intro = mocks.engine.playStartIntro.mock.calls[0]![0];
        expect(intro.selfId).toBe(2);
        expect(intro.spawns).toEqual([
            { id: 1, x: 384, y: 384, colorIndex: 0, label: '1' },
            { id: 2, x: 640, y: 896, colorIndex: 1, label: '2' },
        ]);
        expect(intro.selfLabel).toBe('game.introSelf');
        expect(container.querySelector('[data-testid=loading]')?.getAttribute('data-ready')).toBe('true');

        // 카운트다운 동안에는 이동 입력을 보내지 않는다(서버도 시뮬레이션을 돌리지 않는다).
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
        await act(async () => { vi.advanceTimersByTime(200); });
        expect(mocks.sendInput).not.toHaveBeenCalled();

        // 숫자는 도착한 뒤 마지막 3초에만 뜬다.
        expect(container.querySelector('[role=timer]')).toBeNull();
        await act(async () => { vi.advanceTimersByTime(COUNTDOWN_MS - 3000); });
        expect(container.querySelector('[role=timer]')?.textContent).toBe('3');
    });

    it('starts no intro when the server sent no start positions', async () => {
        mocks.session = countdownSession();
        await act(async () => root.render(<GamePage />));
        await settle();
        expect(mocks.engine.playStartIntro).not.toHaveBeenCalled();
        expect(container.querySelector('[data-testid=loading]')?.getAttribute('data-ready')).toBe('false');
    });
});
