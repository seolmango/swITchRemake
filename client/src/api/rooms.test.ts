import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }));

vi.mock('./http.ts', () => ({ apiRequest }));

import { getAlreadyAssignedLobbyPath, resumeRoom, type RoomAssignment } from './rooms.ts';

describe('getAlreadyAssignedLobbyPath', () => {
    it('returns the assigned room lobby route', () => {
        const assignment: RoomAssignment = { alreadyAssigned: true, roomId: 'e5f78493-101b-42f8-9b22-c88dfd217fa7' };
        expect(getAlreadyAssignedLobbyPath(assignment)).toBe('/rooms/e5f78493-101b-42f8-9b22-c88dfd217fa7/lobby');
    });

    it('reports an assigned response without a room id', () => {
        expect(() => getAlreadyAssignedLobbyPath({ alreadyAssigned: true })).toThrow('ACTIVE_ROOM_MISSING');
    });
});

describe('resumeRoom', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('sessionStorage', { removeItem: vi.fn() });
    });

    it('clears the saved active room when the authoritative resume attempt fails', async () => {
        apiRequest.mockRejectedValueOnce(new Error('room no longer exists'));

        await expect(resumeRoom('8a10eba3-af9b-468a-b4f8-7aef34c7310d')).rejects.toThrow('room no longer exists');

        expect(sessionStorage.removeItem).toHaveBeenCalledWith('switch-active-room');
    });
});
