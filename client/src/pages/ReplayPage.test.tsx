// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwitchEngine } from '../game/index.ts';

const mocks = vi.hoisted(() => ({
    verifiedMapView: vi.fn(), loadReplayVerifier: vi.fn(), createReplayTicket: vi.fn(),
    engineCallback: null as null | ((engine: SwitchEngine | null) => void),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'ko' } }) }));
vi.mock('../stores/useSettingsStore.ts', () => ({ useSettingsStore: (select: (state: { theme: number }) => unknown) => select({ theme: 0 }) }));
vi.mock('../components/layout/PageLayout.tsx', () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock('../components/common/Icon.tsx', () => ({ Icon: () => <span /> }));
vi.mock('../components/common/RoundButton.tsx', () => ({ RoundButton: ({ content }: { content: string }) => <button>{content}</button> }));
vi.mock('../game/index.ts', () => ({ EngineMode: { Spectate: 'spectate' } }));
vi.mock('shared', async (original) => ({ ...await original<typeof import('shared')>(), decodeSnapshot: () => ({ tick: 0, full: true, players: [] }) }));
vi.mock('../game/SwitchGame.tsx', () => ({ SwitchGame: ({ onEngine }: { onEngine: (engine: SwitchEngine | null) => void }) => { mocks.engineCallback = onEngine; return <div data-testid="canvas" />; } }));
vi.mock('../game/mapBundle.ts', () => ({ verifiedMapView: mocks.verifiedMapView }));
vi.mock('../replay/browserVerifier.ts', () => ({ loadReplayVerifier: mocks.loadReplayVerifier }));
vi.mock('../api/profile.ts', () => ({ createReplayTicket: mocks.createReplayTicket }));
vi.mock('../api/config.ts', () => ({ getRetentionSettings: vi.fn(async () => ({ matchDays: 30, replayHours: 2 })) }));
vi.mock('../replay/replayFile.ts', () => ({
    ReplayOpenError: class extends Error {},
    readReplayFile: vi.fn(async () => new Uint8Array()),
    openReplay: vi.fn(async () => ({ verification: 'unverified', chunkIndex: [{}], manifest: {
        startTick: 0, endTick: 3600, durationTicks: 3600, snapshotHz: 30, mapId: 'BattleField', mapBundleHash: 'test-hash', protocolVersion: 1, participants: [],
    } })),
    // 분석 화면은 chunk에서 프레임·사건·시야를 함께 꺼낸다. 첫 프레임과 마지막 프레임 사이가 60초다.
    loadChunk: vi.fn(async () => ({
        frames: [{ tick: 0, full: true, bytes: new Uint8Array(1) }, { tick: 3600, full: false, bytes: new Uint8Array(1) }],
        events: [],
        visibilities: [],
    })),
    frameBuffer: vi.fn(() => new ArrayBuffer(0)),
}));
import { ReplayPage } from './ReplayPage.tsx';
import { openReplay } from '../replay/replayFile.ts';

describe('replay renderer initialization', () => {
    let root: Root;
    let container: HTMLDivElement;
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        mocks.engineCallback = null;
        mocks.loadReplayVerifier.mockResolvedValue({ verify: vi.fn() });
        mocks.verifiedMapView.mockResolvedValue({ simulationHz: 60, view: { cols: 1, rows: 1, tiles: [[0]] } });
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
    });
    it('loads the verified map when the canvas engine becomes ready after the file', async () => {
        await act(async () => root.render(<MemoryRouter><ReplayPage /></MemoryRouter>));
        const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
        Object.defineProperty(input, 'files', { value: [new File(['test'], 'layout-test.swrp')] });
        await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
        expect(mocks.engineCallback).not.toBeNull();
        const engine = {
            map: { load: vi.fn() },
            camera: { fitMap: vi.fn(), setZoom: vi.fn(), follow: vi.fn(), centerOn: vi.fn() },
            whenReady: vi.fn(async () => undefined), applySnapshot: vi.fn(), setSelf: vi.fn(),
        } as unknown as SwitchEngine;
        await act(async () => mocks.engineCallback!(engine));
        expect(mocks.verifiedMapView).toHaveBeenCalledWith('BattleField', 'test-hash', window.location.origin);
        expect(engine.map.load).toHaveBeenCalledOnce();
        expect(engine.camera.fitMap).toHaveBeenCalledWith(64);
        expect(engine.applySnapshot).toHaveBeenCalledOnce();
        expect(engine.applySnapshot).toHaveBeenCalledWith(expect.any(ArrayBuffer), 60);
        // 길이는 맵 번들의 시뮬레이션 주기(60Hz)로 바꾼 값이다. 30Hz로 잘못 나누면 2:00이 된다.
        expect(container.textContent).toContain('1:00.0');
        expect(container.textContent).not.toContain('2:00');
        expect(mocks.loadReplayVerifier).toHaveBeenCalledOnce();
    });

    it('단축키로 재생 위치를 옮긴다', async () => {
        await act(async () => root.render(<MemoryRouter><ReplayPage /></MemoryRouter>));
        const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
        Object.defineProperty(input, 'files', { value: [new File(['test'], 'layout-test.swrp')] });
        await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
        const engine = {
            map: { load: vi.fn() },
            camera: { fitMap: vi.fn(), setZoom: vi.fn(), follow: vi.fn(), centerOn: vi.fn() },
            whenReady: vi.fn(async () => undefined), applySnapshot: vi.fn(), setSelf: vi.fn(),
        } as unknown as SwitchEngine;
        await act(async () => mocks.engineCallback!(engine));
        const clock = () => container.querySelector('.replay-clock b')!.textContent;
        expect(clock()).toBe('0:00.0');
        await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' })); });
        expect(clock()).toBe('1:00.0');
        await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' })); });
        expect(clock()).toBe('0:00.0');
    });

    it('전적의 바로 재생은 표로 파일을 받아 저장 없이 연다', async () => {
        mocks.createReplayTicket.mockResolvedValue({ path: '/replays/match-1.swrp?ticket=abc', expiresInMs: 60_000 });
        const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
        vi.stubGlobal('fetch', fetchMock);
        await act(async () => root.render(<MemoryRouter initialEntries={['/replay?match=m-1']}><ReplayPage /></MemoryRouter>));
        expect(mocks.createReplayTicket).toHaveBeenCalledWith('m-1');
        expect(fetchMock).toHaveBeenCalledWith(`${window.location.origin}/replays/match-1.swrp?ticket=abc`, { cache: 'no-store' });
        expect(openReplay).toHaveBeenCalledOnce();
        expect(container.querySelector('[data-testid=canvas]')).not.toBeNull();
        expect(container.textContent).toContain('replay.save');
    });

    it('게스트 세션의 403은 로그인을 권하고, 참가자가 아니라는 403은 그렇지 않다', async () => {
        const { ApiError } = await import('../api/http.ts');
        mocks.createReplayTicket.mockRejectedValue(new ApiError(403, { message: 'This endpoint requires an account' } as never));
        await act(async () => root.render(<MemoryRouter initialEntries={['/replay?match=m-1']}><ReplayPage /></MemoryRouter>));
        expect(container.textContent).toContain('replay.fetchLogin');
        await act(async () => root.unmount());
        root = createRoot(container);
        mocks.createReplayTicket.mockRejectedValue(new ApiError(403, { code: 'NOT_MATCH_PARTICIPANT', message: 'x' } as never));
        await act(async () => root.render(<MemoryRouter initialEntries={['/replay?match=m-2']}><ReplayPage /></MemoryRouter>));
        expect(container.textContent).toContain('replay.fetchFailed');
    });

    it('보관이 끝난 경기는 이유를 말하고 파일을 고를 수 있게 둔다', async () => {
        const { ApiError } = await import('../api/http.ts');
        mocks.createReplayTicket.mockRejectedValue(new ApiError(404, null));
        await act(async () => root.render(<MemoryRouter initialEntries={['/replay?match=m-1']}><ReplayPage /></MemoryRouter>));
        expect(container.textContent).toContain('replay.fetchGone');
        expect(container.querySelector('input[type=file]')).not.toBeNull();
        expect(openReplay).not.toHaveBeenCalled();
    });
});
