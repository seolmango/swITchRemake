// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwitchEngine } from '../game/index.ts';

const mocks = vi.hoisted(() => ({
    verifiedMapView: vi.fn(), loadReplayVerifier: vi.fn(),
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
vi.mock('../replay/replayFile.ts', () => ({
    ReplayOpenError: class extends Error {},
    readReplayFile: vi.fn(async () => new Uint8Array()),
    openReplay: vi.fn(async () => ({ verification: 'unverified', chunkIndex: [{}], manifest: {
        durationTicks: 3600, snapshotHz: 30, mapId: 'BattleField', mapBundleHash: 'test-hash', protocolVersion: 1, participants: [],
    } })),
    loadFrames: vi.fn(async () => [{ tick: 0, full: true }]),
    frameBuffer: vi.fn(() => new ArrayBuffer(0)),
}));
import { ReplayPage } from './ReplayPage.tsx';

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
        await act(async () => root.render(<ReplayPage />));
        const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
        Object.defineProperty(input, 'files', { value: [new File(['test'], 'layout-test.swrp')] });
        await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
        expect(mocks.engineCallback).not.toBeNull();
        const engine = { map: { load: vi.fn() }, camera: { fitMap: vi.fn() }, whenReady: vi.fn(async () => undefined), applySnapshot: vi.fn() } as unknown as SwitchEngine;
        await act(async () => mocks.engineCallback!(engine));
        expect(mocks.verifiedMapView).toHaveBeenCalledWith('BattleField', 'test-hash', window.location.origin);
        expect(engine.map.load).toHaveBeenCalledOnce();
        expect(engine.camera.fitMap).toHaveBeenCalledWith(64);
        expect(engine.applySnapshot).toHaveBeenCalledOnce();
        expect(engine.applySnapshot).toHaveBeenCalledWith(expect.any(ArrayBuffer), 60);
        expect(container.textContent).toContain('1:00');
        expect(container.textContent).not.toContain('2:00');
        expect(mocks.loadReplayVerifier).toHaveBeenCalledOnce();
    });
});
