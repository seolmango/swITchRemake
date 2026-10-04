// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getRooms: vi.fn(), t: (key: string) => key }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn(), useLocation: () => ({ state: null }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('../../stores/useSettingsStore.ts', () => ({ useSettingsStore: (selector: (state: { theme: number }) => unknown) => selector({ theme: 0 }) }));
vi.mock('../../api/rooms.ts', () => ({ getRooms: mocks.getRooms }));
vi.mock('../../game/GameSession.ts', () => ({ gameSession: {} }));
vi.mock('../../components/layout/PageLayout.tsx', () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock('../../components/common/RoundBox.tsx', () => ({ RoundBox: () => null }));
vi.mock('../../components/common/RoundButton.tsx', () => ({ RoundButton: ({ ariaLabel, onClick, disabled }: { ariaLabel: string; onClick: () => void; disabled?: boolean }) => <button aria-label={ariaLabel} onClick={onClick} disabled={disabled} /> }));
vi.mock('../../components/room/RoomCard.tsx', () => ({ RoomCard: ({ room }: { room: { name: string } }) => <span>{room.name}</span> }));
import { RoomListPage } from './RoomListPage.tsx';

const listing = (name: string, totalPages = 2) => ({ rooms: [{ id: name, name }], totalPages });
const deferred = () => {
    let resolve!: (value: ReturnType<typeof listing>) => void;
    const promise = new Promise<ReturnType<typeof listing>>(done => { resolve = done; });
    return { promise, resolve };
};

describe('room list request ordering', () => {
    let root: Root;
    let container: HTMLDivElement;
    const click = async (label: string) => act(async () => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
    beforeEach(async () => {
        vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        mocks.getRooms.mockResolvedValue(listing('page-one'));
        container = document.createElement('div'); document.body.append(container); root = createRoot(container);
        await act(async () => root.render(<RoomListPage />));
    });
    afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

    it('keeps page two when a manual refresh for page one finishes later', async () => {
        const oldRefresh = deferred();
        mocks.getRooms.mockReturnValueOnce(oldRefresh.promise);
        await click('rooms.refresh');
        mocks.getRooms.mockResolvedValueOnce(listing('page-two'));
        await click('nav.nextPage');
        expect(container.textContent).toContain('page-two');
        await act(async () => oldRefresh.resolve(listing('stale-page-one')));
        expect(container.textContent).toContain('page-two');
        expect(container.textContent).not.toContain('stale-page-one');
    });

    it('returns to an existing page after manual refresh observes fewer pages', async () => {
        await click('nav.nextPage');
        mocks.getRooms.mockResolvedValue(listing('shrunk-page', 1));
        await click('rooms.refresh');
        expect(container.querySelector('.room-pagination')!.textContent).toBe('1 / 1');
    });
});
