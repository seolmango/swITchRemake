// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/http.ts';

const mocks = vi.hoisted(() => ({ search: '', navigate: vi.fn(), joinRoom: vi.fn(), connect: vi.fn() }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate, useSearchParams: () => [new URLSearchParams(mocks.search)] }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../stores/useSettingsStore.ts', () => ({ useSettingsStore: (select: (state: { theme: number }) => unknown) => select({ theme: 0 }) }));
vi.mock('../../components/layout/PageLayout.tsx', () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock('../../components/common/RoundBox.tsx', () => ({ RoundBox: () => null }));
vi.mock('../../components/common/TextField.tsx', () => ({ TextField: ({ label, value, onChange, disabled, type }: { label: string; value: string; onChange: (value: string) => void; disabled?: boolean; type?: string }) => <label>{label}<input aria-label={label} value={value} disabled={disabled} type={type} onInput={(event) => onChange(event.currentTarget.value)} onChange={() => undefined} /></label> }));
vi.mock('../../components/common/RoundButton.tsx', () => ({ RoundButton: ({ content, onClick, disabled, isLoading }: { content: string; onClick: () => void; disabled?: boolean; isLoading?: boolean }) => <button disabled={disabled || isLoading} onClick={onClick}>{content}</button> }));
vi.mock('../../api/rooms.ts', () => ({ joinRoom: mocks.joinRoom, isAlreadyAssigned: (result: object) => 'alreadyAssigned' in result, getAlreadyAssignedLobbyPath: () => '/existing/lobby' }));
vi.mock('../../game/GameSession.ts', () => ({ gameSession: { connect: mocks.connect } }));
import { JoinRoomPage } from './JoinRoomPage.tsx';
import { roomErrorMessage } from './roomErrorMessage.ts';

describe('manual room-code joining', () => {
    let root: Root;
    let container: HTMLDivElement;
    const field = (name: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
    const input = async (name: string, value: string) => {
        const element = field(name);
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
            element.dispatchEvent(new Event('input', { bubbles: true }));
        });
    };
    const submit = async () => act(async () => container.querySelector('button')!.click());
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        mocks.search = '';
        mocks.joinRoom.mockResolvedValue({ roomId: 'test-room' });
        mocks.connect.mockResolvedValue(undefined);
        container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    });
    afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

    it('allows a manually entered private-room code and password without a pw URL parameter', async () => {
        await act(async () => root.render(<JoinRoomPage />));
        expect(field('rooms.password').disabled).toBe(false);
        await input('rooms.roomId', 'ABC234');
        await input('rooms.password', '1234');
        await submit();
        expect(mocks.joinRoom).toHaveBeenCalledWith('ABC234', '1234');
        expect(mocks.connect).toHaveBeenCalledWith({ roomId: 'test-room' }, { isPrivate: true });
        expect(mocks.navigate).toHaveBeenCalledWith('/rooms/test-room/lobby');
    });
    it('joins a public room without a password and validates an optional password when present', async () => {
        await act(async () => root.render(<JoinRoomPage />));
        await input('rooms.roomId', 'ABC234');
        expect(container.querySelector('button')!.disabled).toBe(false);
        await input('rooms.password', '12');
        expect(container.querySelector('button')!.disabled).toBe(true);
        await input('rooms.password', '');
        await submit();
        expect(mocks.joinRoom).toHaveBeenCalledWith('ABC234', undefined);
        expect(mocks.connect).toHaveBeenCalledWith({ roomId: 'test-room' }, { isPrivate: false });
    });
    it('keeps the password required for a selected private room but clears that requirement for a different code', async () => {
        mocks.search = 'room_code=ABC234&pw=true';
        await act(async () => root.render(<JoinRoomPage />));
        expect(container.querySelector('button')!.disabled).toBe(true);
        await input('rooms.roomId', 'BCD234');
        expect(container.querySelector('button')!.disabled).toBe(false);
        await submit();
        expect(mocks.joinRoom).toHaveBeenCalledWith('BCD234', undefined);
    });
    it('preserves the code and password after a masked rejection so the player can retry', async () => {
        mocks.joinRoom.mockRejectedValueOnce(new ApiError(409, { code: 'ROOM_UNAVAILABLE' }));
        await act(async () => root.render(<JoinRoomPage />));
        await input('rooms.roomId', 'ABC234'); await input('rooms.password', '1234'); await submit();
        expect(container.querySelector('[role=status]')!.textContent).toBe('rooms.errors.roomUnavailable');
        expect(field('rooms.roomId').value).toBe('ABC234'); expect(field('rooms.password').disabled).toBe(false);
        await input('rooms.password', '5678'); await submit();
        expect(mocks.joinRoom).toHaveBeenLastCalledWith('ABC234', '5678');
    });
    it('keeps missing-room and bad-password errors masked without treating unrelated forbidden errors as passwords', () => {
        for (const code of ['ROOM_UNAVAILABLE', 'ROOM_NOT_FOUND', 'BAD_PASSWORD']) {
            expect(roomErrorMessage(new ApiError(409, { code }), (key) => key)).toBe('rooms.errors.roomUnavailable');
        }
        expect(roomErrorMessage(new ApiError(403, { code: 'UNKNOWN_PERMISSION_FAILURE' }), (key) => key)).toBe('auth.serverError');
    });
});
